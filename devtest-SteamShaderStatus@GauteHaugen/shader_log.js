// Parser and state machine for Steam's logs/shader_log.txt.
// Pure JS with no GI imports, so it runs under both Cinnamon (GJS) and node for tests.

const STATE_IDLE = 'idle';
const STATE_PROCESSING = 'processing';
const STATE_STALLED = 'stalled';

const RATE_WINDOW = 6;      // ticks used for the rate slope (~60 s)
const MIN_TICKS_FOR_ETA = 3;
const MAX_COMPLETED = 50;

const TIMESTAMP_RE = /^\[(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\] (.*)$/;

const PATTERNS = [
    { event: 'progress', re: /^Still replaying (\d+) \((\d+)%, (\d+)\/(\d+)\)\./ },
    { event: 'start', re: /^Starting processing job for app (\d+)!/ },
    { event: 'start', re: /^Starting replay of FOZ databases for AppID (\d+) / },
    { event: 'requeue', re: /^Requeuing processing for app (\d+)\./ },
    { event: 'completed', re: /^\[ App ID (\d+) \] fossilize_replay completed, remove from build queue\./ },
    { event: 'destroyed', re: /^Destroyed compile job (\d+)\./ },
    { event: 'driverPrune', re: /^Pruning old NVIDIA driver directory/ },
];

// Log timestamps are local time. Date() with components interprets them as local.
function parseTimestamp(y, mo, d, h, mi, s) {
    return Math.floor(new Date(+y, +mo - 1, +d, +h, +mi, +s).getTime() / 1000);
}

function parseLine(line) {
    // Steam writes CRLF line endings.
    const m = TIMESTAMP_RE.exec(line.replace(/\r$/, ''));
    if (!m) return null;
    const time = parseTimestamp(m[1], m[2], m[3], m[4], m[5], m[6]);
    const body = m[7];
    for (const p of PATTERNS) {
        const pm = p.re.exec(body);
        if (!pm) continue;
        const ev = { event: p.event, time };
        if (p.event === 'progress') {
            ev.appid = pm[1];
            ev.percent = parseInt(pm[2], 10);
            ev.done = parseInt(pm[3], 10);
            ev.total = parseInt(pm[4], 10);
        } else if (p.event !== 'driverPrune') {
            ev.appid = pm[1];
        }
        return ev;
    }
    return null;
}

class ShaderLogState {
    constructor() {
        this.job = null;          // { appid, startedAt, percent, done, total, lastTickAt, ticks: [{t, done}] }
        this.completed = [];      // [{ appid, finishedAt }], newest last
        this.lastDriverPrune = null;
        // Appids that reported progress. Only these count as completed: Steam also
        // starts and finishes many tiny jobs within a second, which are just noise.
        this._progressAppids = new Set();
        this._listeners = [];
    }

    // Listener receives (type, data) for 'jobStarted' (first progress tick of a job)
    // and 'jobCompleted'.
    onEvent(fn) {
        this._listeners.push(fn);
    }

    _emit(type, data) {
        for (const fn of this._listeners) {
            try {
                fn(type, data);
            } catch (e) {
                // Listener errors must not break parsing.
            }
        }
    }

    feedLine(line) {
        const ev = parseLine(line);
        if (ev) this.apply(ev);
        return ev;
    }

    apply(ev) {
        switch (ev.event) {
            case 'start':
                if (this.job && this.job.appid === ev.appid) {
                    // A second phase (e.g. "Starting replay of FOZ databases") restarts done/total.
                    this.job.ticks = [];
                    this.job.lastTickAt = ev.time;
                } else {
                    this._newJob(ev.appid, ev.time);
                }
                break;
            case 'progress': {
                if (!this.job || this.job.appid !== ev.appid)
                    this._newJob(ev.appid, ev.time);
                const job = this.job;
                if (!this._progressAppids.has(ev.appid)) {
                    this._progressAppids.add(ev.appid);
                    this._emit('jobStarted', { appid: ev.appid, time: ev.time });
                }
                const last = job.ticks[job.ticks.length - 1];
                if (last && ev.done < last.done)
                    job.ticks = [];
                job.ticks.push({ t: ev.time, done: ev.done });
                if (job.ticks.length > RATE_WINDOW)
                    job.ticks.shift();
                job.percent = ev.percent;
                job.done = ev.done;
                job.total = ev.total;
                job.lastTickAt = ev.time;
                break;
            }
            case 'completed':
                if (this.job && this.job.appid === ev.appid)
                    this.job = null;
                if (this._progressAppids.has(ev.appid))
                    this._addCompleted(ev.appid, ev.time);
                this._progressAppids.delete(ev.appid);
                break;
            case 'destroyed':
                // Job torn down without completing (e.g. a game was launched).
                if (this.job && this.job.appid === ev.appid)
                    this.job = null;
                break;
            case 'driverPrune':
                this.lastDriverPrune = ev.time;
                break;
        }
    }

    _newJob(appid, time) {
        this.job = {
            appid,
            startedAt: time,
            percent: null,
            done: null,
            total: null,
            lastTickAt: time,
            ticks: [],
        };
    }

    _addCompleted(appid, time) {
        this.completed = this.completed.filter(c => c.appid !== appid);
        this.completed.push({ appid, finishedAt: time });
        if (this.completed.length > MAX_COMPLETED)
            this.completed.shift();
        this._emit('jobCompleted', { appid, time });
    }

    // Drops a job that has been silent for longer than abandonAfter seconds
    // (Steam quit mid-job). Returns true if the job was dropped.
    dropAbandoned(now, abandonAfter) {
        if (this.job && now - this.job.lastTickAt > abandonAfter) {
            this.job = null;
            return true;
        }
        return false;
    }

    getState(now, stallTimeout) {
        if (!this.job) return STATE_IDLE;
        return now - this.job.lastTickAt > stallTimeout ? STATE_STALLED : STATE_PROCESSING;
    }

    // Pipelines per second from a least-squares slope over the tick window, or null.
    getRate() {
        const ticks = this.job ? this.job.ticks : [];
        if (ticks.length < MIN_TICKS_FOR_ETA) return null;
        const n = ticks.length;
        const t0 = ticks[0].t;
        let sx = 0, sy = 0, sxx = 0, sxy = 0;
        for (const { t, done } of ticks) {
            const x = t - t0;
            sx += x; sy += done; sxx += x * x; sxy += x * done;
        }
        const denom = n * sxx - sx * sx;
        if (denom === 0) return null;
        const slope = (n * sxy - sx * sy) / denom;
        return slope > 0 ? slope : null;
    }

    // Seconds remaining, or null when there is no usable rate yet.
    getEta() {
        const rate = this.getRate();
        if (rate === null || this.job.total === null) return null;
        return Math.max(0, this.job.total - this.job.done) / rate;
    }
}

if (typeof module !== 'undefined') {
    module.exports = {
        ShaderLogState, parseLine,
        STATE_IDLE, STATE_PROCESSING, STATE_STALLED,
    };
}

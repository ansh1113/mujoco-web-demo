// requestAnimationFrame driver that advances simulated time in step with wall-clock time,
// capping the work per frame so slow devices degrade to slow-motion instead of freezing.
export class SimLoop {
  /**
   * @param {(simDt: number) => void} advance  advance the simulation by ~simDt seconds
   * @param {() => void} draw                    render one frame
   * @param {number} maxSimPerFrame              cap on simulated seconds per frame
   */
  constructor(advance, draw, maxSimPerFrame = 1 / 30) {
    this.advance = advance;
    this.draw = draw;
    this.maxSim = maxSimPerFrame;
    this.running = false;
    this.paused = false;
    this.last = 0;
    this.speed = 1;      // measured sim-time / wall-time
    this._frame = (t) => this.frame(t);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    requestAnimationFrame(this._frame);
  }

  stop() { this.running = false; }

  frame(now) {
    if (!this.running) return;
    const wall = Math.min((now - this.last) / 1000, 0.1);
    this.last = now;
    if (!this.paused && wall > 0) {
      const dt = Math.min(wall, this.maxSim);
      const simulated = this.advance(dt) ?? dt;
      // when frames get slow, the per-frame cap makes the sim fall behind wall-clock time
      this.speed = 0.95 * this.speed + 0.05 * Math.min(1, simulated / wall);
    }
    this.draw();
    requestAnimationFrame(this._frame);
  }
}

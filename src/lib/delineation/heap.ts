/**
 * Generic Min-Heap (Priority Queue).
 *
 * Used by the Wang & Liu sink-fill algorithm which needs to pop the
 * globally lowest elevation cell on every iteration.
 */
export class MinHeap<T> {
  private heap: T[] = [];
  constructor(private compare: (a: T, b: T) => number) {}

  push(val: T): void {
    this.heap.push(val);
    this.up(this.heap.length - 1);
  }

  pop(): T | undefined {
    if (this.heap.length === 0) return undefined;
    const top = this.heap[0];
    const bottom = this.heap.pop();
    if (this.heap.length > 0 && bottom !== undefined) {
      this.heap[0] = bottom;
      this.down(0);
    }
    return top;
  }

  get length(): number {
    return this.heap.length;
  }

  private up(i: number): void {
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.compare(this.heap[i], this.heap[p]) >= 0) break;
      this.swap(i, p);
      i = p;
    }
  }

  private down(i: number): void {
    const len = this.heap.length;
    while ((i << 1) + 1 < len) {
      let child = (i << 1) + 1;
      if (
        child + 1 < len &&
        this.compare(this.heap[child + 1], this.heap[child]) < 0
      ) {
        child++;
      }
      if (this.compare(this.heap[i], this.heap[child]) <= 0) break;
      this.swap(i, child);
      i = child;
    }
  }

  private swap(i: number, j: number): void {
    const temp = this.heap[i];
    this.heap[i] = this.heap[j];
    this.heap[j] = temp;
  }
}

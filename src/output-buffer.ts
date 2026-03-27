export type OutputStreamName = "stdout" | "stderr";

export type OutputChunk = {
  seq: number;
  stream: OutputStreamName;
  data: string;
};

export class OutputBuffer {
  private readonly maxBufferedOutputBytes: number;
  private nextSeq = 1;
  private chunks: OutputChunk[] = [];
  private bufferedBytes = 0;

  constructor(maxBufferedOutputBytes: number) {
    this.maxBufferedOutputBytes = maxBufferedOutputBytes;
  }

  append(stream: OutputStreamName, data: string): OutputChunk {
    const chunk: OutputChunk = {
      seq: this.nextSeq++,
      stream,
      data,
    };

    this.chunks.push(chunk);
    this.bufferedBytes += Buffer.byteLength(data);
    this.trimToBudget();
    return { ...chunk };
  }

  lastSeq(): number {
    return this.nextSeq - 1;
  }

  firstRetainedSeq(): number | undefined {
    return this.chunks[0]?.seq;
  }

  snapshotUntil(seq: number): OutputChunk[] {
    return this.snapshotWhere((chunk) => chunk.seq <= seq);
  }

  snapshotAfter(seq: number): OutputChunk[] {
    return this.snapshotWhere((chunk) => chunk.seq > seq);
  }

  trimToBudget(): void {
    while (this.chunks.length > 1 && this.bufferedBytes > this.maxBufferedOutputBytes) {
      const chunk = this.chunks.shift();

      if (!chunk) {
        break;
      }

      this.bufferedBytes -= Buffer.byteLength(chunk.data);
    }
  }

  private snapshotWhere(predicate: (chunk: OutputChunk) => boolean): OutputChunk[] {
    return this.chunks.filter(predicate).map((chunk) => ({ ...chunk }));
  }
}

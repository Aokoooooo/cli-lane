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

  append(stream: OutputStreamName, data: string): void {
    const chunk: OutputChunk = {
      seq: this.nextSeq++,
      stream,
      data,
    };

    this.chunks.push(chunk);
    this.bufferedBytes += Buffer.byteLength(data);
    this.trimToBudget();
  }

  lastSeq(): number {
    return this.nextSeq - 1;
  }

  snapshotUntil(seq: number): OutputChunk[] {
    return this.chunks
      .filter((chunk) => chunk.seq <= seq)
      .map((chunk) => ({ ...chunk }));
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
}

import { Injectable } from "@nestjs/common";

@Injectable()
export class PipelineMetrics {
  private readonly values = new Map<string, number>();
  increment(name: string): void { this.values.set(`${name}_total`, (this.values.get(`${name}_total`) ?? 0) + 1); }
  observe(name: string, seconds: number): void {
    this.values.set(`${name}_seconds_sum`, (this.values.get(`${name}_seconds_sum`) ?? 0) + seconds);
    this.values.set(`${name}_seconds_count`, (this.values.get(`${name}_seconds_count`) ?? 0) + 1);
    for (const bound of [0.01,0.1,0.5,1,5,25,150,Infinity]) {
      if (seconds <= bound) {
        const key = `${name}_seconds_bucket{le="${bound === Infinity ? "+Inf" : bound}"}`;
        this.values.set(key,(this.values.get(key) ?? 0)+1);
      }
    }
  }
  render(): string { return [...this.values].map(([key,value]) => `argus_${key} ${value}`).join("\n") + "\n"; }
}

import { square } from "@lib";
import { double } from "@/lib/helper";

export function compute(n: number): number {
  return square(n) + double(n);
}

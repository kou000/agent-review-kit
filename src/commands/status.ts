import { reviewPaths } from '../paths';
import { buildStatus } from '../server';

export function status(cwd: string = process.cwd()): void {
  console.log(JSON.stringify(buildStatus(reviewPaths(cwd)), null, 2));
}

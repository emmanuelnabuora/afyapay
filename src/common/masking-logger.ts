import { ConsoleLogger } from '@nestjs/common';
import { maskSensitive } from './mask';

/** The application logger: every message and context object is masked first. */
export class MaskingLogger extends ConsoleLogger {
  log(message: unknown, ...rest: unknown[]): void {
    super.log(maskSensitive(message), ...rest.map((r) => maskSensitive(r)));
  }
  error(message: unknown, ...rest: unknown[]): void {
    super.error(maskSensitive(message), ...rest.map((r) => maskSensitive(r)));
  }
  warn(message: unknown, ...rest: unknown[]): void {
    super.warn(maskSensitive(message), ...rest.map((r) => maskSensitive(r)));
  }
  debug(message: unknown, ...rest: unknown[]): void {
    super.debug(maskSensitive(message), ...rest.map((r) => maskSensitive(r)));
  }
  verbose(message: unknown, ...rest: unknown[]): void {
    super.verbose(maskSensitive(message), ...rest.map((r) => maskSensitive(r)));
  }
}

import {
  BadRequestException,
  CallHandler,
  ConflictException,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  SetMetadata,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { catchError, from, Observable, of, switchMap, throwError } from 'rxjs';
import { hashRequest, IdempotencyService } from './idempotency.service';

export const SKIP_IDEMPOTENCY = 'afyapay:skip-idempotency';

/**
 * Opt a route out of Idempotency-Key checks. Only for provider webhooks, which
 * cannot send the header and are de-duplicated by provider reference in the inbox.
 */
export const SkipIdempotency = (): MethodDecorator & ClassDecorator => SetMetadata(SKIP_IDEMPOTENCY, true);

const KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const PROTECTED_METHODS = new Set(['POST']);

/**
 * Applies the Idempotency-Key rules from the Step 6 API design to every POST:
 * missing or malformed key -> 400; same key + same body -> the first response;
 * same key + different body -> 409; same key still running -> 409.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly idempotency: IdempotencyService,
    private readonly reflector: Reflector,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const req = context.switchToHttp().getRequest<Request & { user?: { id?: string } }>();
    if (!PROTECTED_METHODS.has(req.method)) return next.handle();
    if (this.reflector.getAllAndOverride<boolean>(SKIP_IDEMPOTENCY, [context.getHandler(), context.getClass()])) {
      return next.handle();
    }

    const key = req.header('idempotency-key');
    if (!key || !KEY_PATTERN.test(key)) {
      throw new BadRequestException({ code: 'request.idempotency_key_required', message: 'Send an Idempotency-Key header of 8 to 128 letters, digits, - or _.' });
    }
    const actor = req.user?.id ?? 'anonymous';
    const scope = `${req.method} ${req.route?.path ?? req.path} ${actor}`;
    const res = context.switchToHttp().getResponse<Response>();
    // Nest sets the status code after interceptors run, so read it from the route.
    const routeStatus = this.reflector.get<number>(HTTP_CODE_METADATA, context.getHandler()) ?? 201;

    return from(this.idempotency.start(scope, key, hashRequest(req.body))).pipe(
      switchMap((start) => {
        switch (start.kind) {
          case 'replay':
            res.status(start.status);
            res.setHeader('Idempotent-Replay', 'true');
            return of(start.body);
          case 'conflict':
            throw new ConflictException({ code: 'request.idempotency_key_reused', message: 'This Idempotency-Key was already used with a different request body.' });
          case 'in_progress':
            throw new ConflictException({ code: 'request.in_progress', message: 'A request with this Idempotency-Key is still being processed.' });
          case 'new':
            return next.handle().pipe(
              switchMap((body) => from(this.idempotency.complete(scope, key, routeStatus, body)).pipe(switchMap(() => of(body)))),
              catchError((err) => from(this.idempotency.release(scope, key)).pipe(switchMap(() => throwError(() => err)))),
            );
        }
      }),
    );
  }
}

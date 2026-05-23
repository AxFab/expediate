/* Copyright 2021 Fabien Bavent
 *
 * Permission is hereby granted, free of charge, to any person obtaining a
 * copy of this software and associated documentation files (the "Software"),
 * to deal in the Software without restriction, including without limitation
 * the rights to use, copy, modify, merge, publish, distribute, sublicense,
 * and/or sell copies of the Software, and to permit persons to whom the
 * Software is furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included
 * in all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
 * OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL
 * THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
 * DEALINGS IN THE SOFTWARE.
 */
/**
 * @module expediate
 * TypeScript package for web server routing.
 */

// ── Router ────────────────────────────────────────────────────────────────────
import createRouter from './router';
export { createRouter }
export type {
  Router,
  RouterRequest,
  RouterResponse,
  Middleware,
  MiddlewareArg,
  NextFunction,
  Layer,
  CookieOptions,
  TlsOptions,
  StringMap,
} from './router';

// ── Static ────────────────────────────────────────────────────────────────────

export { serveStatic, serveFile, sendFile, mime } from './static';
export type {
  StaticOptions,
  Mime
} from './static';

// ── Miscallenous ──────────────────────────────────────────────────────────────

export { json, formData, parseBody, logger, cors } from './misc';
export type {
  BodyOptions,
  LoggerOptions,
  FormPart,
} from './misc';

// ── JWT Authentication ────────────────────────────────────────────────────────
import createJwtPlugin from './jwt-auth'
export { createJwtPlugin }
export type {
  JwtPlugin,
  JwtConfig
} from './jwt-auth';

// ── Git repository ────────────────────────────────────────────────────────────
export { gitHandler, gitCreate } from './git'
export type {
    GitHandlerOptions,
} from './git'

// ── API Service ───────────────────────────────────────────────────────────────
import apiBuilder from './apis'
export { apiBuilder }
export type {
    ApiError,
    ServiceMethod,
    ServiceInstance,
    ServiceMethods,
    RouteMap,
    ServiceDefinition
} from './apis'

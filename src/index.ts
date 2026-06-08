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
import createRouter from './router.js';
export { createRouter }
export type {
  Router,
  RouterOptions,
  RouterRequest,
  RouterResponse,
  Middleware,
  MiddlewareArg,
  NextFunction,
  Layer,
  CookieOptions,
  TlsOptions,
  StringMap,
} from './router.js';

// ── Static ────────────────────────────────────────────────────────────────────

export { serveStatic, serveFile, sendFile, mime } from './static.js';
export type {
  StaticOptions,
  Mime
} from './static.js';

// ── Miscallenous ──────────────────────────────────────────────────────────────

export { json, formData, formEncoded, parseBody, logger, cors, streamFormData, parseMultipartBody } from './misc.js';
export type {
  BodyOptions,
  LoggerOptions,
  FormPart,
  FormPartStream,
} from './misc.js';

// ── JWT Authentication ────────────────────────────────────────────────────────
import createJwtPlugin from './jwt-auth.js';
export { createJwtPlugin };
export { createMapTokenStore } from './jwt-auth.js';
export type {
  JwtPlugin,
  JwtConfig,
  TokenStore,
  RefreshTokenRecord,
} from './jwt-auth.js';

// ── Git repository ────────────────────────────────────────────────────────────
export { gitHandler, gitCreate } from './git.js';
export type {
    GitHandlerOptions,
} from './git.js';

// ── API Service ───────────────────────────────────────────────────────────────
import apiBuilder from './apis.js';
export { apiBuilder }
export type {
    ApiError,
    ServiceMethod,
    ServiceInstance,
    ServiceMethods,
    RouteMap,
    ServiceDefinition,
    ApiRouter,
    ApiRouterExtensions,
    ApiContext,
} from './apis.js';

// ── OpenAPI spec generation ───────────────────────────────────────────────────
export { describe, openApiSpec, serializeSpec, DESCRIBE_META } from './openapi.js';
export type {
    JsonSchema,
    ParameterObject,
    RequestBodyObject,
    ResponseObject,
    OperationMeta,
    OpenApiServiceMeta,
    SpecOptions,
    SpecFormat,
    OpenApiDocument,
} from './openapi.js';

// ── Middleware ────────────────────────────────────────────────────────────────
export { compress, requestId, rateLimit, cacheControl, csrf, securityHeaders, conditionalGet } from './middleware.js';
export type {
  CompressOptions,
  RequestIdOptions,
  RateLimitOptions,
  CacheControlOptions,
  CsrfOptions,
  SecurityHeadersOptions,
} from './middleware.js';

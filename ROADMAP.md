# Expediate — Roadmap

This document lists all known defects, missing features, and improvement ideas
for the **expediate** package, grouped by category and ordered by priority
within each section.

---

## Part 1 — Bug Fixes

These are correctness or safety issues that should be resolved before the
package is used in any production environment.

---

### 🔴 Critical

_None_

### 🟠 High

_None_

### 🟡 Medium

_None_

## Part 2 — Missing Features

These are capabilities commonly expected of a production HTTP server framework
that expediate currently lacks entirely.

---

### 🔴 Critical (production blockers)

_None_

### 🟠 High

_None_

### 🟡 Medium

_None_


## Part 3 — Nice-to-Have

Ideas that would make the package more ergonomic or feature-complete but are
not strictly necessary for correctness or stability.

---

#### NTH-01 · WebSocket upgrade support

The router has no hook for the HTTP `upgrade` event, making WebSocket servers
impossible to co-locate with the HTTP API on the same port.

**Proposal:** expose `router.ws(path, handler)` that intercepts the upgrade
handshake and manages the WebSocket lifecycle, or at minimum expose
`router.onUpgrade(fn)` to give the raw event to the caller.

---

#### NTH-02 · CLI scaffold (`npx expediate init`)

A `create-expediate` CLI or an `npx expediate init` command that scaffolds a
minimal server project (TypeScript config, entry point, a sample route) would
significantly lower the time-to-first-request for new users.

---

#### NTH-03 · Request body schema validation hook

`apiBuilder` service methods receive the parsed body as-is. Adding an optional
`schema` field per route (compatible with a simple hand-rolled validator or an
external library like Zod or Valibot) would enable automatic 400 responses for
malformed input before the handler is ever called.

---

#### NTH-04 · Cluster / multi-process helper

Node.js `cluster` module integration (fork workers, handle signals, zero-downtime
restarts) is boilerplate that every production server has to write. A thin
`cluster(router, opts)` wrapper would make expediate self-contained for
single-host deployments.

---

## Summary Table

| ID       | Category    | Priority | Title                                          |
|----------|-------------|----------|------------------------------------------------|
| NTH-01   | Nice-to-have| —        | WebSocket upgrade support                      |
| NTH-02   | Nice-to-have| —        | CLI scaffold (`npx expediate init`)            |
| NTH-03   | Nice-to-have| —        | Request body schema validation hook            |
| NTH-04   | Nice-to-have| —        | Cluster / multi-process helper                 |

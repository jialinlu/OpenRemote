'use strict';
const { ID_PATTERN } = require('./protocol.cjs');

const SESSION_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const TIMEOUT_MS = 30_000;

class TerminalConsent {
  #current = null;

  get pending() {
    // A suspended or busy host can resume after the deadline before its timer runs.
    if (this.#current && Date.now() >= this.#current.deadline) this.clear();
    return this.#current?.ticket ?? null;
  }

  begin(peerId, sessionId) {
    if (this.pending || typeof peerId !== 'string' || !ID_PATTERN.test(peerId) ||
        typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return null;
    const controller = new AbortController();
    const ticket = Object.freeze({ peerId, sessionId, signal: controller.signal });
    const timer = setTimeout(() => {
      if (this.#current?.ticket === ticket) this.clear();
    }, TIMEOUT_MS);
    timer.unref?.();
    this.#current = { ticket, controller, timer, deadline: Date.now() + TIMEOUT_MS };
    return ticket;
  }

  isCurrent(ticket) { return !!ticket && this.pending === ticket; }

  consume(ticket) {
    if (!this.isCurrent(ticket)) return false;
    clearTimeout(this.#current.timer);
    this.#current = null;
    return true;
  }

  cancel(peerId, sessionId) {
    const ticket = this.pending;
    return !!ticket && ticket.peerId === peerId && ticket.sessionId === sessionId && this.clear();
  }

  clear() {
    const current = this.#current;
    if (!current) return false;
    this.#current = null;
    clearTimeout(current.timer);
    current.controller.abort();
    return true;
  }
}

module.exports = { TerminalConsent };

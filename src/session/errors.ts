export class SessionBusyError extends Error {
  constructor(message = "Session is busy") {
    super(message);
    this.name = "SessionBusyError";
  }
}

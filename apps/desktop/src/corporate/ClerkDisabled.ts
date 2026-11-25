const unavailable = (): never => {
  throw new Error("T3 Connect authentication is unavailable in the corporate build.");
};

export {
  unavailable as createClerkBridge,
  unavailable as exposeClerkBridge,
  unavailable as storage,
};

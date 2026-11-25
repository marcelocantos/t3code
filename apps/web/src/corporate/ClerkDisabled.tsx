const unavailable = (): never => {
  throw new Error("T3 Connect authentication is unavailable in the corporate build.");
};

const signedOut = Object.freeze({
  isLoaded: true,
  isSignedIn: false,
  userId: null,
  sessionId: null,
  sessionClaims: null,
  actor: null,
  orgId: null,
  orgRole: null,
  orgSlug: null,
  orgPermissions: [],
  getToken: async () => null,
  has: () => false,
  signOut: unavailable,
});

function readCorporateAuthState() {
  return signedOut;
}

export const UserButton = Object.assign(unavailable, { UserProfilePage: unavailable });
export {
  readCorporateAuthState as useAuth,
  unavailable as ClerkProvider,
  unavailable as useClerk,
  unavailable as passkeys,
};

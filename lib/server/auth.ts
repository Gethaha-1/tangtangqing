export type TrustedIdentity = {
  provider: "chatgpt";
  providerSubject: string;
  email: string;
  displayName: string;
};

const EMAIL_HEADER = "oai-authenticated-user-email";
const NAME_HEADER = "oai-authenticated-user-full-name";
const NAME_ENCODING_HEADER = "oai-authenticated-user-full-name-encoding";

export class AuthenticationError extends Error {
  constructor() {
    super("请先使用 ChatGPT 登录");
    this.name = "AuthenticationError";
  }
}

/**
 * Reads identity only from dispatcher/worker-owned headers. Request bodies,
 * query strings and localStorage are deliberately never identity sources.
 */
export function getTrustedIdentity(request: Request): TrustedIdentity {
  const email = request.headers.get(EMAIL_HEADER)?.trim().toLowerCase();
  if (!email) throw new AuthenticationError();

  const encodedName = request.headers.get(NAME_HEADER);
  const displayName =
    encodedName &&
    request.headers.get(NAME_ENCODING_HEADER) === "percent-encoded-utf-8"
      ? safeDecode(encodedName) || email
      : email;

  return {
    provider: "chatgpt",
    // Sites currently forwards email as its stable ChatGPT identity claim.
    // It is scoped to the identity table; all business rows use internal ids.
    providerSubject: email,
    email,
    displayName,
  };
}

function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

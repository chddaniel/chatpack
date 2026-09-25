export const SOCIAL_PROVIDERS = ["google", "github"] as const;

export type SocialProvider = (typeof SOCIAL_PROVIDERS)[number];

export function socialProviderCredentials(
  provider: SocialProvider,
): { clientId: string; clientSecret: string } | undefined {
  const prefix = provider.toUpperCase();
  const clientId = process.env[`${prefix}_CLIENT_ID`];
  const clientSecret = process.env[`${prefix}_CLIENT_SECRET`];
  if (!clientId && !clientSecret) return undefined;
  if (!clientId || !clientSecret) {
    throw new Error(
      `${prefix}_CLIENT_ID and ${prefix}_CLIENT_SECRET must both be set to enable ${provider} sign-in.`,
    );
  }
  return { clientId, clientSecret };
}

export function enabledSocialProviders(): readonly SocialProvider[] {
  return SOCIAL_PROVIDERS.filter((provider) => socialProviderCredentials(provider) !== undefined);
}

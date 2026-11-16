import * as pulumi from '@pulumi/pulumi';

// Everything the program needs, read and checked before a single resource is
// declared. A missing secret must fail here, naming the variable — not later as
// "connection refused" from a provider that was reached first.

export type Profile = 'safe' | 'broken';

export interface Settings {
  kubeContext: string;
  namespace: string;
  name: string;
  image: string;
  replicas: number;
  nodePort: number;
  rev: string;
  profile: Profile;
  dbPassword: pulumi.Output<string>;
}

function requireEnv(name: string, purpose: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new pulumi.RunError(
      `${name} is not set — ${purpose}. It comes from the secret store: ` +
        `run through scripts/with-secrets.sh (npm run up), or export ${name} with SKIP_VAULT=1.`,
    );
  }
  return value;
}

function profileFromEnv(): Profile {
  const value = process.env.ROLLOUT_PROFILE ?? 'safe';
  if (value !== 'safe' && value !== 'broken') {
    throw new pulumi.RunError(`ROLLOUT_PROFILE must be "safe" or "broken", got "${value}"`);
  }
  return value;
}

export function loadSettings(): Settings {
  const dbPassword = requireEnv('DB_PASSWORD', 'the database password the pods read from a K8s Secret');

  const config = new pulumi.Config();
  const replicas = config.requireNumber('replicas');
  if (!Number.isInteger(replicas) || replicas < 2) {
    throw new pulumi.RunError(`replicas must be an integer >= 2 (a PDB over one replica protects nothing), got ${replicas}`);
  }

  return {
    kubeContext: config.require('kubeContext'),
    namespace: config.require('namespace'),
    name: config.require('name'),
    image: config.require('image'),
    replicas,
    nodePort: config.requireNumber('nodePort'),
    // The pod template must change for a rollout to happen; a rebuilt image under
    // the same tag changes nothing Kubernetes can see.
    rev: process.env.APP_REV ?? '1',
    profile: profileFromEnv(),
    dbPassword: pulumi.secret(dbPassword),
  };
}

import * as aws from '@pulumi/aws';
import * as pulumi from '@pulumi/pulumi';

// The base stack holds only what is free: a budget, the network, the security
// groups and the role CI assumes. Nothing in here is billed by the hour — no RDS,
// ALB, NAT, EC2 or Elastic IP — so it may stay up for a week. Those live in the
// demo stack (infra/demo), which exists for the length of a session.

const cfg = new pulumi.Config('hw31');
const githubRepo = cfg.require('githubRepo'); // owner/repo — the only repo CI may come from
const region = aws.config.requireRegion();

// The fallback lane points the provider at LocalStack through AWS_ENDPOINT_URL. The
// community edition has no Budgets API (501), so there the budget is skipped — and
// only there: against real AWS it is created, before anything else.
const emulated = Boolean(process.env.AWS_ENDPOINT_URL);

// --- 1. Budget: the first resource, before the VPC ------------------------------
// A letter, not a brake: AWS refreshes actual spend every 8–12 hours. ACTUAL spend,
// not a forecast — a forecast needs about five weeks of history a new account has
// not got, so a forecast-based alert would never fire.
const ALERT_PERCENT = 20; // 20 % of $5 = $1 of actual spend
const alertEmail = process.env.ALERT_EMAIL; // from the secret store, never from git

const budget = emulated
  ? undefined
  : new aws.budgets.Budget('monthly', {
      budgetType: 'COST',
      timeUnit: 'MONTHLY',
      // $5 a month for the whole account, not filtered by tag: a tag becomes a
      // cost-allocation key in billing only after a delay, a resource label at once.
      limitAmount: '5',
      limitUnit: 'USD',
      notifications: [
        {
          notificationType: 'ACTUAL',
          comparisonOperator: 'GREATER_THAN',
          threshold: ALERT_PERCENT,
          thresholdType: 'PERCENTAGE',
          subscriberEmailAddresses: alertEmail ? [alertEmail] : [],
        },
      ],
    });
if (!emulated && !alertEmail) {
  throw new Error('ALERT_EMAIL is not set: a budget nobody is told about is no budget (see .env.example)');
}

// Everything below depends on the budget, so even a parallel `up` creates it first.
const after: pulumi.CustomResourceOptions = { dependsOn: budget ? [budget] : [] };

// --- 2. Network -----------------------------------------------------------------
// 10.31.0.0/16 overlaps neither Docker's 172.16/12 bridges nor kind's pod network.
const vpc = new aws.ec2.Vpc(
  'vpc',
  { cidrBlock: '10.31.0.0/16', enableDnsHostnames: true, enableDnsSupport: true, tags: { Name: 'hw31' } },
  after,
);

// Two different zones: Multi-AZ RDS needs a subnet in each, so does an ALB.
const azs = [`${region}a`, `${region}b`];

const publicSubnets = azs.map(
  (az, i) =>
    new aws.ec2.Subnet(`public-${i}`, {
      vpcId: vpc.id,
      availabilityZone: az,
      cidrBlock: `10.31.${i}.0/24`,
      // No public IPv4 on launch: an address is $0.005/h, and nothing here needs one.
      mapPublicIpOnLaunch: false,
      tags: { Name: `hw31-public-${az}`, Tier: 'public' },
    }),
);

const privateSubnets = azs.map(
  (az, i) =>
    new aws.ec2.Subnet(`private-${i}`, {
      vpcId: vpc.id,
      availabilityZone: az,
      cidrBlock: `10.31.${10 + i}.0/24`,
      tags: { Name: `hw31-private-${az}`, Tier: 'private' },
    }),
);

const igw = new aws.ec2.InternetGateway('igw', { vpcId: vpc.id, tags: { Name: 'hw31' } });

// The public table is the only one with a default route, and it goes to the IGW.
const publicRt = new aws.ec2.RouteTable('public', {
  vpcId: vpc.id,
  routes: [{ cidrBlock: '0.0.0.0/0', gatewayId: igw.id }],
  tags: { Name: 'hw31-public' },
});
publicSubnets.forEach(
  (s, i) => new aws.ec2.RouteTableAssociation(`public-${i}`, { subnetId: s.id, routeTableId: publicRt.id }),
);

// "Private" is the absence of a line: this table has no 0.0.0.0/0 at all — neither to
// the IGW nor to a NAT. Only the database lives here, and it never calls out.
// An explicit table rather than the VPC's main one, so no later edit to the main
// table can make these subnets public by accident.
const privateRt = new aws.ec2.RouteTable('private', {
  vpcId: vpc.id,
  routes: [],
  tags: { Name: 'hw31-private' },
});
privateSubnets.forEach(
  (s, i) => new aws.ec2.RouteTableAssociation(`private-${i}`, { subnetId: s.id, routeTableId: privateRt.id }),
);

// --- 3. Security groups ---------------------------------------------------------
// Stateful: an allowed request's reply is let back in without a rule of its own,
// so each group lists only what may start a connection.

const albSg = new aws.ec2.SecurityGroup('alb', {
  vpcId: vpc.id,
  description: 'hw31 ALB: HTTP from the internet',
  ingress: [
    // 80 from anywhere: the ALB is internet-facing and serves plain HTTP — there is
    // no domain, so there is no certificate, so there is no 443 listener to open.
    { protocol: 'tcp', fromPort: 80, toPort: 80, cidrBlocks: ['0.0.0.0/0'], description: 'HTTP from the internet' },
  ],
  egress: [
    // Out to the VPC only: the ALB talks to its targets, never to the internet.
    { protocol: 'tcp', fromPort: 0, toPort: 65535, cidrBlocks: ['10.31.0.0/16'], description: 'to targets in the VPC' },
  ],
  tags: { Name: 'hw31-alb' },
});

const appSg = new aws.ec2.SecurityGroup('app', {
  vpcId: vpc.id,
  description: 'hw31 app: traffic from the ALB only',
  ingress: [
    // 3000 — the API's port — and only from the ALB's group, not from a CIDR: a
    // target is reachable through the balancer or not at all.
    { protocol: 'tcp', fromPort: 3000, toPort: 3000, securityGroups: [albSg.id], description: 'API from the ALB' },
  ],
  egress: [
    // 5432 into the VPC: the app's only outbound need is the database.
    { protocol: 'tcp', fromPort: 5432, toPort: 5432, cidrBlocks: ['10.31.0.0/16'], description: 'to Postgres' },
  ],
  tags: { Name: 'hw31-app' },
});

const dbSg = new aws.ec2.SecurityGroup('db', {
  vpcId: vpc.id,
  description: 'hw31 RDS: Postgres from the app only',
  ingress: [
    // 5432 from the app group only. No CIDR, no 0.0.0.0/0: the database answers the
    // application and nothing else, whatever its subnet's routes say.
    { protocol: 'tcp', fromPort: 5432, toPort: 5432, securityGroups: [appSg.id], description: 'Postgres from the app' },
  ],
  // No egress rules: Postgres replies on connections it accepted (stateful), and
  // replication between primary and standby is AWS's network, not this group's.
  egress: [],
  tags: { Name: 'hw31-db' },
});

// --- 4. The role CI assumes over OIDC -------------------------------------------
// No access key anywhere: GitHub signs a short-lived JWT, STS trades it for
// credentials of this role, and only for workflows of this one repository.
const github = new aws.iam.OpenIdConnectProvider('github', {
  url: 'https://token.actions.githubusercontent.com',
  clientIdLists: ['sts.amazonaws.com'],
  // Ignored by AWS for GitHub since 2023 (it trusts the CA), still required by older APIs.
  thumbprintLists: ['6938fd4d98bab03faadb97b34396831e3780aea1'],
});

const teardownRole = new aws.iam.Role('teardown', {
  name: 'hw31-teardown',
  description: 'Assumed by .github/workflows/teardown.yml to destroy the demo stack and prove it is gone',
  maxSessionDuration: 3600,
  assumeRolePolicy: github.arn.apply((arn) =>
    JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Principal: { Federated: arn },
          Action: 'sts:AssumeRoleWithWebIdentity',
          Condition: {
            StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com' },
            // Any ref of this repository (the scheduled run is on the default branch,
            // the dispatched one on the branch it was started from) — no other repo.
            StringLike: { 'token.actions.githubusercontent.com:sub': `repo:${githubRepo}:*` },
          },
        },
      ],
    }),
  ),
});

// Least privilege for teardown: read what is needed to find the demo stack's
// resources, delete only what carries Project=nodejs-pro-hw31. Every action is
// named; README "## AWS" explains each line.
const tagged = { StringEquals: { 'aws:ResourceTag/Project': 'nodejs-pro-hw31' } };
export const teardownPolicyDocument = {
  Version: '2012-10-17',
  Statement: [
    {
      Sid: 'ReadForChecksAndDestroy',
      Effect: 'Allow',
      Action: [
        'tag:GetResources',
        'rds:DescribeDBInstances',
        'rds:DescribeDBSubnetGroups',
        'rds:ListTagsForResource',
        'elasticloadbalancing:DescribeLoadBalancers',
        'elasticloadbalancing:DescribeLoadBalancerAttributes',
        'elasticloadbalancing:DescribeListeners',
        'elasticloadbalancing:DescribeTargetGroups',
        'elasticloadbalancing:DescribeTargetGroupAttributes',
        'elasticloadbalancing:DescribeTargetHealth',
        'elasticloadbalancing:DescribeTags',
        'ec2:DescribeNatGateways',
        'ec2:DescribeAddresses',
        'lambda:GetFunction',
        'lambda:GetPolicy',
        'lambda:ListVersionsByFunction',
        'iam:GetRole',
        'iam:ListAttachedRolePolicies',
        'iam:ListRolePolicies',
        'iam:ListInstanceProfilesForRole',
      ],
      Resource: '*', // Describe/List calls take no resource ARN
    },
    {
      Sid: 'DeleteOnlyTagged',
      Effect: 'Allow',
      Action: [
        'rds:DeleteDBInstance',
        'rds:DeleteDBSubnetGroup',
        'elasticloadbalancing:DeleteLoadBalancer',
        'elasticloadbalancing:DeleteListener',
        'elasticloadbalancing:DeleteTargetGroup',
        'elasticloadbalancing:DeregisterTargets',
        'ec2:DeleteNatGateway',
        'ec2:ReleaseAddress',
        'ec2:DisassociateAddress',
        'lambda:DeleteFunction',
        'lambda:RemovePermission',
      ],
      Resource: '*',
      Condition: tagged,
    },
    {
      Sid: 'DeleteTheDemoTargetRole',
      Effect: 'Allow',
      Action: ['iam:DetachRolePolicy', 'iam:DeleteRole'],
      Resource: pulumi.interpolate`arn:aws:iam::${aws.getCallerIdentityOutput().accountId}:role/hw31-demo-*`,
    },
  ],
};

new aws.iam.RolePolicy('teardown', {
  role: teardownRole.id,
  name: 'hw31-teardown',
  policy: pulumi.output(teardownPolicyDocument).apply((d) => JSON.stringify(d)),
});

// --- Outputs: read by the demo stack (StackReference) and by scripts/aws-evidence.sh
export const vpcId = vpc.id;
export const publicSubnetIds = publicSubnets.map((s) => s.id);
export const privateSubnetIds = privateSubnets.map((s) => s.id);
export const privateRouteTableId = privateRt.id;
export const albSecurityGroupId = albSg.id;
export const appSecurityGroupId = appSg.id;
export const dbSecurityGroupId = dbSg.id;
export const teardownRoleArn = teardownRole.arn;
export const teardownRoleName = teardownRole.name;
export const budgetName = budget ? budget.name : 'skipped: no Budgets API in the LocalStack community edition';

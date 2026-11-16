import * as aws from '@pulumi/aws';
import * as pulumi from '@pulumi/pulumi';

// The demo stack: everything billed by the hour, up for the length of a session.
// It reads the network from the base stack and owns nothing that base needs.

// Registered before the first resource, so it applies to every RDS instance this
// program will ever declare: a forgotten deletionProtection makes `destroy` fail, a
// final snapshot outlives `destroy` and keeps billing. Both turn teardown into a bill.
pulumi.runtime.registerResourceTransform((args) =>
  args.type === 'aws:rds/instance:Instance'
    ? { props: { ...args.props, deletionProtection: false, skipFinalSnapshot: true }, opts: args.opts }
    : undefined,
);

const cfg = new pulumi.Config('hw31');
const withNat = cfg.getBoolean('withNat') ?? false;
// organization/<project>/<stack> on a file backend, <org>/<project>/<stack> on Pulumi Cloud.
const base = new pulumi.StackReference(cfg.get('baseStack') ?? 'organization/hw31-base/base');

const publicSubnetIds = base.requireOutput('publicSubnetIds') as pulumi.Output<string[]>;
const privateSubnetIds = base.requireOutput('privateSubnetIds') as pulumi.Output<string[]>;
const albSecurityGroupId = base.requireOutput('albSecurityGroupId') as pulumi.Output<string>;
const dbSecurityGroupId = base.requireOutput('dbSecurityGroupId') as pulumi.Output<string>;

// The master password comes from the store of homework 11 (DB_PASSWORD via
// scripts/with-secrets.sh) and enters the state only as a Pulumi secret.
const dbPassword = process.env.DB_PASSWORD;
if (!dbPassword) throw new Error('DB_PASSWORD is not set: run through scripts/with-secrets.sh');

// --- RDS: a Multi-AZ *instance* deployment ---------------------------------------
// Not a Multi-AZ DB *cluster*: that mode needs db.c6gd/m5d/m6gd classes and starts at
// $0.2385/h. Here: one primary, one synchronous standby in the other AZ, one endpoint.
const dbSubnets = new aws.rds.SubnetGroup('db', {
  subnetIds: privateSubnetIds, // the two private subnets, one per AZ — no route out
  description: 'hw31: private subnets only',
});

const db = new aws.rds.Instance('db', {
  identifier: 'hw31-db',
  engine: 'postgres',
  engineVersion: '16',
  instanceClass: 'db.t4g.micro',
  multiAz: true,
  allocatedStorage: 20,
  storageType: 'gp3',
  storageEncrypted: true, // with the AWS-managed aws/rds key — no customer key to bill
  backupRetentionPeriod: 1,
  dbName: 'marketplace',
  username: 'marketplace',
  password: pulumi.secret(dbPassword),
  dbSubnetGroupName: dbSubnets.name,
  vpcSecurityGroupIds: [dbSecurityGroupId],
  publiclyAccessible: false,
  // Neither is graded, both are billed.
  performanceInsightsEnabled: false,
  monitoringInterval: 0,
  applyImmediately: true,
  // deletionProtection: false and skipFinalSnapshot: true come from the transform above.
});

// --- ALB → a Lambda target --------------------------------------------------------
// A Lambda rather than an EC2: no extra hourly line, no third public IPv4. The ALB
// itself still holds two public IPv4 (one per subnet) — $7.30 a month in addresses.
const targetRole = new aws.iam.Role('target', {
  name: 'hw31-demo-target', // teardown may delete roles named hw31-demo-* only
  assumeRolePolicy: JSON.stringify({
    Version: '2012-10-17',
    Statement: [{ Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' }],
  }),
});
new aws.iam.RolePolicyAttachment('target-logs', {
  role: targetRole.name,
  policyArn: 'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
});

const target = new aws.lambda.Function('target', {
  name: 'hw31-demo-target',
  runtime: 'nodejs22.x',
  handler: 'index.handler',
  role: targetRole.arn,
  timeout: 3,
  memorySize: 128,
  code: new pulumi.asset.AssetArchive({
    'index.js': new pulumi.asset.StringAsset(
      `exports.handler = async () => ({
  statusCode: 200,
  statusDescription: '200 OK',
  isBase64Encoded: false,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ status: 'ok', served_by: 'lambda', at: new Date().toISOString() }),
});
`,
    ),
  }),
});

const alb = new aws.lb.LoadBalancer('alb', {
  name: 'hw31-alb',
  internal: false, // internet-facing
  loadBalancerType: 'application',
  subnets: publicSubnetIds,
  securityGroups: [albSecurityGroupId],
  enableDeletionProtection: false,
});

const tg = new aws.lb.TargetGroup('target', {
  name: 'hw31-target',
  targetType: 'lambda',
  // Off by default for Lambda targets: without it the state is "unavailable", never
  // "healthy", and that is the line demo:alb reads, not just the status code.
  healthCheck: { enabled: true, path: '/', interval: 30, timeout: 5, healthyThreshold: 2, matcher: '200' },
});

const invoke = new aws.lambda.Permission('alb-invoke', {
  action: 'lambda:InvokeFunction',
  function: target.name,
  principal: 'elasticloadbalancing.amazonaws.com',
  sourceArn: tg.arn,
});

new aws.lb.TargetGroupAttachment('target', { targetGroupArn: tg.arn, targetId: target.arn }, { dependsOn: [invoke] });

new aws.lb.Listener('http', {
  loadBalancerArn: alb.arn,
  port: 80,
  protocol: 'HTTP',
  defaultActions: [{ type: 'forward', targetGroupArn: tg.arn }],
});

// --- NAT, behind hw31:withNat (default off) ---------------------------------------
// Up only for demo:nat, which raises it and tears it down at once. No route points at
// it: the private subnets stay private, the exercise is the bill, not the traffic.
// Each started NAT-hour is billed in full: $0.052 + $0.005 for its public IPv4.
let nat: aws.ec2.NatGateway | undefined;
if (withNat) {
  const eip = new aws.ec2.Eip('nat', { domain: 'vpc' });
  nat = new aws.ec2.NatGateway('nat', {
    allocationId: eip.id,
    subnetId: publicSubnetIds.apply((ids) => ids[0]),
    connectivityType: 'public',
  });
}

export const dbIdentifier = db.identifier;
export const dbEndpoint = db.address;
export const albDns = alb.dnsName;
export const targetGroupArn = tg.arn;
export const natGatewayId = nat ? nat.id : 'none (hw31:withNat=false)';

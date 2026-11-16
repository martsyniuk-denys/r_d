#!/usr/bin/env bash
#
#   bash scripts/with-secrets.sh dev bash scripts/aws-evidence.sh base|iam
#
# base → evidence/base.txt (key=number, read back from the AWS API — not from the
#        program's intent) and evidence/base-state.json (`pulumi stack export`, as is).
# iam  → evidence/iam.json (get-role + the permission policy, both decoded) and
#        evidence/iam.txt (sim-allowed / sim-denied from simulate-principal-policy).
#
# Every value is asked of the API the stack lives in. On the fallback lane that is
# LocalStack — see README "## AWS" for what that API does and does not prove.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EV="$ROOT/evidence"; mkdir -p "$EV"
export PULUMI_BACKEND_URL="${PULUMI_BACKEND_URL:-file://$ROOT/.pulumi}"
export PULUMI_SKIP_UPDATE_CHECK=true

cd "$ROOT/infra/base"
pulumi stack select base --non-interactive >/dev/null
R="$(pulumi config get aws:region)"
out() { pulumi stack output "$1" --show-secrets; }

case "${1:-}" in
  base)
    VPC="$(out vpcId)"
    PUB="$(out publicSubnetIds --json | jq -r '.[]')"
    PRIV="$(out privateSubnetIds --json | jq -r '.[]')"

    # A subnet is public if its route table sends 0.0.0.0/0 to an internet gateway —
    # counted from the routes, not from the Name or Tier tags.
    default_routes() { # $1 = subnet id → number of 0.0.0.0/0 routes in its table
      aws ec2 describe-route-tables --region "$R" \
        --filters "Name=association.subnet-id,Values=$1" \
        --query 'length(RouteTables[].Routes[?DestinationCidrBlock==`0.0.0.0/0`][])' --output text
    }
    igw_routes() {
      aws ec2 describe-route-tables --region "$R" \
        --filters "Name=association.subnet-id,Values=$1" \
        --query 'length(RouteTables[].Routes[?DestinationCidrBlock==`0.0.0.0/0` && starts_with(GatewayId||``, `igw-`)][])' --output text
    }
    pub=0; for s in $PUB; do [ "$(igw_routes "$s")" -ge 1 ] && pub=$((pub + 1)); done
    priv=0; priv_routes=0
    for s in $PRIV; do
      n="$(default_routes "$s")"
      [ "$n" -eq 0 ] && priv=$((priv + 1))
      priv_routes=$((priv_routes + n))
    done

    azs="$(aws ec2 describe-subnets --region "$R" --filters "Name=vpc-id,Values=$VPC" \
            --query 'Subnets[].AvailabilityZone' --output text | tr '\t' '\n' | sort -u | grep -c .)"
    # The VPC's own `default` group is not ours: it exists in every VPC.
    sgs="$(aws ec2 describe-security-groups --region "$R" --filters "Name=vpc-id,Values=$VPC" \
            --query 'length(SecurityGroups[?GroupName!=`default`])' --output text)"
    tagged="$(aws resourcegroupstaggingapi get-resources --region "$R" \
            --tag-filters Key=Project,Values=nodejs-pro-hw31 --query 'length(ResourceTagMappingList)' --output text)"

    {
      echo "region=$R"
      echo "vpc-id=$VPC"
      echo "public-subnets=$pub"
      echo "private-subnets=$priv"
      echo "subnet-azs=$azs"
      echo "private-default-route=$priv_routes"
      echo "security-groups=$sgs"
      echo "tagged-resources=$tagged"
    } | tee "$EV/base.txt"
    pulumi stack export > "$EV/base-state.json"
    echo "evidence/base-state.json: $(jq '.deployment.resources | length' "$EV/base-state.json") resources"
    ;;

  iam)
    ROLE="$(out teardownRoleName)"; ARN="$(out teardownRoleArn)"
    # Depending on the CLI version the documents arrive as objects or URL-encoded
    # strings; both are decoded here, so the file is plain JSON all the way down.
    decode='const s=require("fs").readFileSync(0,"utf8");const d=(v)=>typeof v==="string"?JSON.parse(decodeURIComponent(v)):v;
      const j=JSON.parse(s);console.log(JSON.stringify(j,(k,v)=>/PolicyDocument$/.test(k)?d(v):v,null,2));'
    role="$(aws iam get-role --region "$R" --role-name "$ROLE")"
    policies="$(for p in $(aws iam list-role-policies --region "$R" --role-name "$ROLE" --query 'PolicyNames[]' --output text); do
                  aws iam get-role-policy --region "$R" --role-name "$ROLE" --policy-name "$p"
                done | jq -s .)"
    jq -n --argjson role "$role" --argjson p "$policies" '{Role: $role.Role, PermissionPolicies: $p}' \
      | node -e "$decode" > "$EV/iam.json"
    echo "evidence/iam.json: trust + $(jq '.PermissionPolicies|length' "$EV/iam.json") permission policy"

    # One action the role has, one it must not have: teardown deletes, it never
    # creates — a role that could create a database could also run up the bill.
    sim() {
      aws iam simulate-principal-policy --region "$R" --policy-source-arn "$ARN" \
        --action-names "$1" --resource-arns '*' --query 'EvaluationResults[0].EvalDecision' --output text
    }
    {
      echo "engine=$([ -n "${AWS_ENDPOINT_URL:-}" ] && echo localstack || echo aws)"
      echo "sim-allowed-action=ec2:DescribeNatGateways"
      echo "sim-allowed=$(sim ec2:DescribeNatGateways)"
      echo "sim-denied-action=rds:CreateDBInstance"
      echo "sim-denied=$(sim rds:CreateDBInstance)"
    } | tee "$EV/iam.txt"
    ;;

  *) echo "usage: $0 base|iam" >&2; exit 2 ;;
esac

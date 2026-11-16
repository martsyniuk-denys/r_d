#!/usr/bin/env bash
#
#   npm run evidence:localstack-iam
#
# What the LocalStack community edition does with IAM: nothing. Every code below is
# the HTTP status of a real signed request (curl --aws-sigv4), with ENFORCE_IAM=1 set
# on the container (localstack/compose.yml). Writes evidence/localstack-iam.txt:
#
#   no-policy=200            a user with no policy at all creates a bucket
#   deny-all=200             the same user under {"Effect":"Deny","Action":"*",...}
#                            creates another bucket and puts an object
#   fake-key=200             a key LocalStack never issued reads that object back
#   oidc-forged-jwt=200      a role trusting repo:acme/shop hands out credentials for
#                            an unsigned JWT with sub=repo:EVIL/attacker, aud=WRONG
#   enforce-iam-log-lines=0  container log lines about a denial or enforcement
#
# A 200 here proves no policy is right — only that nobody read it.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EP="${AWS_ENDPOINT_URL:?the fallback lane: AWS_ENDPOINT_URL=http://127.0.0.1:23166 in the store}"
# us-east-1 for the probe: a CreateBucket anywhere else needs a location body, and
# the region has nothing to do with whether IAM is read.
R=us-east-1
export AWS_REGION=$R
OUT="$ROOT/evidence/localstack-iam.txt"
CONTAINER="$(docker compose -f "$ROOT/localstack/compose.yml" ps -q localstack)"
SINCE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# The whole transcript goes to the file, not only the keys: the lines above them are
# what the keys were measured from.
exec > >(tee "$OUT") 2>&1

U=hw31-probe-nobody; B1=hw31-probe-a-$$; B2=hw31-probe-b-$$; ROLE=hw31-probe-oidc
cleanup() {
  aws s3 rb "s3://$B1" --force --region $R >/dev/null 2>&1 || true
  aws s3 rb "s3://$B2" --force --region $R >/dev/null 2>&1 || true
  aws iam delete-user-policy --user-name $U --policy-name deny-all >/dev/null 2>&1 || true
  for k in $(aws iam list-access-keys --user-name $U --query 'AccessKeyMetadata[].AccessKeyId' --output text 2>/dev/null); do
    aws iam delete-access-key --user-name $U --access-key-id "$k" >/dev/null 2>&1 || true
  done
  aws iam delete-user --user-name $U >/dev/null 2>&1 || true
  aws iam delete-role --role-name $ROLE >/dev/null 2>&1 || true
  [ -z "${OWN_OIDC:-}" ] || aws iam delete-open-id-connect-provider --open-id-connect-provider-arn "$OWN_OIDC" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# code <key> <secret> <method> <path> [body] → HTTP status of a SigV4-signed S3 call
code() {
  curl -s -o /dev/null -w '%{http_code}' -X "$3" --aws-sigv4 "aws:amz:$R:s3" --user "$1:$2" \
    ${5:+--data-binary "$5"} "$EP/$4"
}

aws iam create-user --user-name $U >/dev/null
read -r KEY SECRET < <(aws iam create-access-key --user-name $U \
  --query 'AccessKey.[AccessKeyId,SecretAccessKey]' --output text)
echo "user $U: $(aws iam list-user-policies --user-name $U --query 'length(PolicyNames)') inline, \
$(aws iam list-attached-user-policies --user-name $U --query 'length(AttachedPolicies)') attached policies"

no_policy="$(code "$KEY" "$SECRET" PUT "$B1")"
echo "  no policy:  CreateBucket $B1 → $no_policy"

aws iam put-user-policy --user-name $U --policy-name deny-all \
  --policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Deny","Action":"*","Resource":"*"}]}'
create="$(code "$KEY" "$SECRET" PUT "$B2")"
put="$(code "$KEY" "$SECRET" PUT "$B2/secret.txt" 'only the owner should read this')"
echo "  deny-all:   CreateBucket $B2 → $create, PutObject → $put"

fake="$(curl -s -w ' %{http_code}' --aws-sigv4 "aws:amz:$R:s3" --user TOTALLY_FAKE_KEY_12345:nope "$EP/$B2/secret.txt")"
echo "  fake key:   GetObject → ${fake##* } (body: ${fake% *})"

# OIDC: a role whose trust says repo:acme/shop, and a token that says otherwise —
# wrong sub, wrong aud, alg=none and no signature at all.
OIDC_ARN="$(aws iam list-open-id-connect-providers --query 'OpenIDConnectProviderList[0].Arn' --output text)"
if [ "$OIDC_ARN" = None ]; then
  aws iam create-open-id-connect-provider --url https://token.actions.githubusercontent.com \
    --client-id-list sts.amazonaws.com --thumbprint-list 6938fd4d98bab03faadb97b34396831e3780aea1 >/dev/null
  OIDC_ARN="$(aws iam list-open-id-connect-providers --query 'OpenIDConnectProviderList[0].Arn' --output text)"
  OWN_OIDC="$OIDC_ARN"
fi
aws iam create-role --role-name $ROLE --assume-role-policy-document "$(jq -nc --arg p "$OIDC_ARN" '{Version:"2012-10-17",Statement:[{Effect:"Allow",Principal:{Federated:$p},Action:"sts:AssumeRoleWithWebIdentity",Condition:{StringEquals:{"token.actions.githubusercontent.com:aud":"sts.amazonaws.com"},StringLike:{"token.actions.githubusercontent.com:sub":"repo:acme/shop:*"}}}]}')" >/dev/null
b64() { base64 | tr -d '=\n' | tr '/+' '_-'; }
JWT="$(printf '{"alg":"none","typ":"JWT"}' | b64).$(printf '{"iss":"https://token.actions.githubusercontent.com","sub":"repo:EVIL/attacker:ref:refs/heads/main","aud":"WRONG","exp":%s}' $(( $(date +%s) + 600 )) | b64)."
sts="$(curl -s -w ' %{http_code}' "$EP/" -d Action=AssumeRoleWithWebIdentity -d Version=2011-06-15 \
  -d "RoleArn=arn:aws:iam::000000000000:role/$ROLE" -d RoleSessionName=evil \
  --data-urlencode "WebIdentityToken=$JWT")"
oidc="${sts##* }"
echo "  forged JWT: AssumeRoleWithWebIdentity → $oidc, AccessKeyId $(grep -oE '<AccessKeyId>[^<]+' <<<"$sts" | cut -d'>' -f2)"

logs="$(docker logs --since "$SINCE" "$CONTAINER" 2>&1)"
iam_lines="$(grep -ciE '\biam\b|aws\.iam|sts\.' <<<"$logs" || true)"
deny_lines="$(grep -ciE 'denied|deny|enforc|not authori[sz]ed|forbidden' <<<"$logs" || true)"

{
  echo "localstack=4.14.0"
  echo "enforce-iam=$(docker exec "$CONTAINER" printenv ENFORCE_IAM)"
  echo "no-policy=$no_policy"
  echo "deny-all=$([ "$create" = 200 ] && [ "$put" = 200 ] && echo 200 || echo "$create/$put")"
  echo "fake-key=${fake##* }"
  echo "oidc-forged-jwt=$oidc"
  echo "log-lines=$(grep -c . <<<"$logs")"
  echo "iam-log-lines=$iam_lines"
  echo "enforce-iam-log-lines=$deny_lines"
}

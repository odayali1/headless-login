#!/bin/bash
# Run on the EC2 where FireProx is already installed (venv + aws creds).
# Creates one API Gateway per Microsoft login host. Paste the printed URLs back if needed.
set -euo pipefail
cd "$(dirname "$0")/.."
# Usage on EC2: cd ~/my_project/fireprox && bash this-script
# Default: expect fire.py in current directory.

FIREPY="${FIREPY:-python fire.py}"
REGION="${FIREPROX_AWS_REGION:-us-east-1}"

hosts=(
  https://account.live.com
  https://outlook.live.com
  https://signup.live.com
  https://fpt.live.com
  https://logincdn.msauth.net
  https://logincdn.msftauth.net
  https://acctcdn.msauth.net
  https://acctcdn.msftauth.net
  https://login.microsoft.com
  https://www.office.com
  https://account.microsoft.com
  https://ms-sso.copilot.microsoft.com
)

echo "Creating ${#hosts[@]} FireProx APIs in $REGION"
for url in "${hosts[@]}"; do
  echo "---- $url"
  $FIREPY --command create --url "$url" --region "$REGION" || true
done

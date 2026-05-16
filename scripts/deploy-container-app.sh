#!/usr/bin/env bash
set -euo pipefail

RESOURCE_GROUP="${RESOURCE_GROUP:-rg-azure-cert-gui}"
LOCATION="${LOCATION:-eastus}"
APP_NAME="${APP_NAME:-azure-cert-gui}"
ENVIRONMENT_NAME="${ENVIRONMENT_NAME:-azure-cert-gui-env}"
LOG_WORKSPACE_NAME="${LOG_WORKSPACE_NAME:-azure-cert-gui-law}"
IMAGE_NAME="${IMAGE_NAME:-azure-cert-gui}"
IMAGE_TAG="${IMAGE_TAG:-latest}"
OIDC_APP_DISPLAY_NAME="${OIDC_APP_DISPLAY_NAME:-Azure Cert GUI Container Apps}"
VIEWER_GROUP_NAME="${VIEWER_GROUP_NAME:-Azure Cert GUI Container Viewers}"
OPERATOR_GROUP_NAME="${OPERATOR_GROUP_NAME:-Azure Cert GUI Container Operators}"
ADMIN_GROUP_NAME="${ADMIN_GROUP_NAME:-Azure Cert GUI Container Admins}"
AZURE_CERT_GUI_DB_PATH="${AZURE_CERT_GUI_DB_PATH:-/tmp/azure-cert-gui.sqlite}"
AZURE_CERT_GUI_SQLITE_JOURNAL_MODE="${AZURE_CERT_GUI_SQLITE_JOURNAL_MODE:-WAL}"
AZURE_CERT_GUI__ROTATION__LIVEENABLED="${AZURE_CERT_GUI__ROTATION__LIVEENABLED:-false}"
AZURE_SYNC_CONCURRENCY="${AZURE_SYNC_CONCURRENCY:-4}"
CPU="${CPU:-1.0}"
MEMORY="${MEMORY:-2Gi}"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

run_az() {
  az "$@" --only-show-errors
}

odata_escape() {
  printf "%s" "${1//\'/\'\'}"
}

mail_nickname() {
  local value
  value="$(printf "%s" "$1" | tr '[:upper:]' '[:lower:]' | tr -cd '[:alnum:]')"
  if [ -z "$value" ]; then
    value="azurecertgui"
  fi
  printf "%.48s" "$value"
}

ensure_group() {
  local display_name="$1"
  local nickname="$2"
  local escaped
  escaped="$(odata_escape "$display_name")"
  local id
  id="$(run_az ad group list --filter "displayName eq '$escaped'" --query '[0].id' -o tsv)"
  if [ -z "$id" ]; then
    id="$(run_az ad group create --display-name "$display_name" --mail-nickname "$nickname" --query id -o tsv)"
  fi
  printf "%s" "$id"
}

json_patch() {
  local url="$1"
  local body="$2"
  local body_path
  body_path="$(mktemp)"
  printf "%s" "$body" > "$body_path"
  run_az rest --method PATCH --url "$url" --headers "Content-Type=application/json" --body "@$body_path" -o none
  rm -f "$body_path"
}

assign_graph_app_roles() {
  local principal_id="$1"
  local graph_sp
  graph_sp="$(run_az ad sp show --id 00000003-0000-0000-c000-000000000000 -o json)"
  python3 - "$principal_id" "$graph_sp" <<'PY'
import json
import os
import subprocess
import sys
import tempfile

principal_id = sys.argv[1]
graph = json.loads(sys.argv[2])
resource_id = graph["id"]
roles = {
    role["value"]: role["id"]
    for role in graph.get("appRoles", [])
    if "Application" in role.get("allowedMemberTypes", [])
}
needed = ["Application.Read.All", "Directory.Read.All", "User.Read.All", "Group.Read.All"]
existing = json.loads(
    subprocess.check_output(
        [
            "az",
            "rest",
            "--method",
            "GET",
            "--url",
            f"https://graph.microsoft.com/v1.0/servicePrincipals/{principal_id}/appRoleAssignments",
            "--only-show-errors",
            "-o",
            "json",
        ],
        text=True,
    )
).get("value", [])
existing_role_ids = {
    assignment.get("appRoleId")
    for assignment in existing
    if assignment.get("resourceId") == resource_id
}
for value in needed:
    role_id = roles.get(value)
    if not role_id or role_id in existing_role_ids:
        continue
    body = {"principalId": principal_id, "resourceId": resource_id, "appRoleId": role_id}
    with tempfile.NamedTemporaryFile("w", delete=False) as f:
        json.dump(body, f)
        path = f.name
    try:
        subprocess.check_call(
            [
                "az",
                "rest",
                "--method",
                "POST",
                "--url",
                f"https://graph.microsoft.com/v1.0/servicePrincipals/{principal_id}/appRoleAssignments",
                "--headers",
                "Content-Type=application/json",
                "--body",
                "@" + path,
                "--only-show-errors",
                "-o",
                "none",
            ]
        )
    finally:
        os.unlink(path)
PY
}

deactivate_zero_traffic_revisions() {
  local revision
  for revision in $(run_az containerapp revision list -g "$RESOURCE_GROUP" -n "$APP_NAME" --query '[?trafficWeight==`0`].name' -o tsv); do
    run_az containerapp revision deactivate -g "$RESOURCE_GROUP" -n "$APP_NAME" --revision "$revision" -o none || true
  done
}

assign_keyvault_access_policies() {
  local principal_id="$1"
  local vaults_json
  vaults_json="$(run_az keyvault list --subscription "$SUBSCRIPTION_ID" --resource-type vault --query '[?properties.enableRbacAuthorization==`false`].[name,resourceGroup]' -o json)"
  python3 - "$principal_id" "$SUBSCRIPTION_ID" "$vaults_json" <<'PY'
import json
import subprocess
import sys

principal_id = sys.argv[1]
subscription_id = sys.argv[2]
vaults = json.loads(sys.argv[3])
for name, resource_group in vaults:
    subprocess.check_call(
        [
            "az",
            "keyvault",
            "set-policy",
            "--name",
            name,
            "--resource-group",
            resource_group,
            "--subscription",
            subscription_id,
            "--object-id",
            principal_id,
            "--secret-permissions",
            "get",
            "list",
            "--certificate-permissions",
            "get",
            "list",
            "--key-permissions",
            "get",
            "list",
            "--only-show-errors",
            "-o",
            "none",
        ]
    )
PY
}

require_command az
require_command openssl
require_command python3

account_json="$(run_az account show -o json)"
SUBSCRIPTION_ID="${AZURE_SUBSCRIPTION_ID:-$(python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])' <<<"$account_json")}"
TENANT_ID="${AZURE_TENANT_ID:-$(python3 -c 'import json,sys; print(json.load(sys.stdin)["tenantId"])' <<<"$account_json")}"
ACR_NAME="${ACR_NAME:-azcg$(printf "%s" "$SUBSCRIPTION_ID" | tr -d '-' | cut -c1-12)}"

run_az account set --subscription "$SUBSCRIPTION_ID" -o none

echo "Creating resource group and registry..."
run_az group create --name "$RESOURCE_GROUP" --location "$LOCATION" -o none
if run_az acr show --resource-group "$RESOURCE_GROUP" --name "$ACR_NAME" -o none >/dev/null 2>&1; then
  run_az acr update --resource-group "$RESOURCE_GROUP" --name "$ACR_NAME" --admin-enabled true -o none
else
  run_az acr create --resource-group "$RESOURCE_GROUP" --name "$ACR_NAME" --sku Basic --admin-enabled true -o none
fi

echo "Preparing Entra OIDC app and role groups..."
viewer_group_id="${VIEWER_GROUP_OBJECT_ID:-$(ensure_group "$VIEWER_GROUP_NAME" "$(mail_nickname "$VIEWER_GROUP_NAME")")}"
operator_group_id="${OPERATOR_GROUP_OBJECT_ID:-$(ensure_group "$OPERATOR_GROUP_NAME" "$(mail_nickname "$OPERATOR_GROUP_NAME")")}"
admin_group_id="${ADMIN_GROUP_OBJECT_ID:-$(ensure_group "$ADMIN_GROUP_NAME" "$(mail_nickname "$ADMIN_GROUP_NAME")")}"

if [ "${ADD_SIGNED_IN_USER_TO_ADMIN:-true}" = "true" ]; then
  signed_in_user_id="$(run_az ad signed-in-user show --query id -o tsv 2>/dev/null || true)"
  if [ -n "$signed_in_user_id" ]; then
    run_az ad group member add --group "$admin_group_id" --member-id "$signed_in_user_id" -o none 2>/dev/null || true
  fi
fi

oidc_app_id="${OIDC_CLIENT_ID:-$(run_az ad app list --display-name "$OIDC_APP_DISPLAY_NAME" --query '[0].appId' -o tsv)}"
if [ -z "$oidc_app_id" ]; then
  oidc_app_id="$(
    run_az ad app create \
      --display-name "$OIDC_APP_DISPLAY_NAME" \
      --sign-in-audience AzureADMyOrg \
      --web-redirect-uris "http://localhost:3000/api/auth/callback" \
      --enable-access-token-issuance false \
      --enable-id-token-issuance false \
      --query appId \
      -o tsv
  )"
fi
oidc_object_id="$(run_az ad app show --id "$oidc_app_id" --query id -o tsv)"
run_az ad app update --id "$oidc_app_id" --set groupMembershipClaims=SecurityGroup -o none
run_az ad sp create --id "$oidc_app_id" -o none >/dev/null 2>&1 || true
oidc_client_secret="$(
  run_az ad app credential reset \
    --id "$oidc_app_id" \
    --append \
    --display-name "Azure Cert GUI Container Apps" \
    --years 1 \
    --query password \
    -o tsv
)"
cookie_secret="${AZURE_CERT_GUI__AUTH__COOKIESECRET:-$(openssl rand -base64 48)}"

echo "Building image in Azure Container Registry..."
run_az acr build --registry "$ACR_NAME" --image "$IMAGE_NAME:$IMAGE_TAG" .

echo "Creating Container Apps environment..."
run_az monitor log-analytics workspace create \
  --resource-group "$RESOURCE_GROUP" \
  --workspace-name "$LOG_WORKSPACE_NAME" \
  --location "$LOCATION" \
  -o none
workspace_id="$(run_az monitor log-analytics workspace show --resource-group "$RESOURCE_GROUP" --workspace-name "$LOG_WORKSPACE_NAME" --query customerId -o tsv)"
workspace_key="$(run_az monitor log-analytics workspace get-shared-keys --resource-group "$RESOURCE_GROUP" --workspace-name "$LOG_WORKSPACE_NAME" --query primarySharedKey -o tsv)"
if ! run_az containerapp env show --resource-group "$RESOURCE_GROUP" --name "$ENVIRONMENT_NAME" -o none >/dev/null 2>&1; then
  run_az containerapp env create \
    --resource-group "$RESOURCE_GROUP" \
    --name "$ENVIRONMENT_NAME" \
    --location "$LOCATION" \
    --logs-workspace-id "$workspace_id" \
    --logs-workspace-key "$workspace_key" \
    -o none
fi

registry_server="$(run_az acr show --resource-group "$RESOURCE_GROUP" --name "$ACR_NAME" --query loginServer -o tsv)"
registry_username="$(run_az acr credential show --name "$ACR_NAME" --query username -o tsv)"
registry_password="$(run_az acr credential show --name "$ACR_NAME" --query 'passwords[0].value' -o tsv)"
environment_id="$(run_az containerapp env show --resource-group "$RESOURCE_GROUP" --name "$ENVIRONMENT_NAME" --query id -o tsv)"

mkdir -p .runtime
cat > .runtime/containerapp.yaml <<EOF
identity:
  type: SystemAssigned
properties:
  managedEnvironmentId: "$environment_id"
  configuration:
    activeRevisionsMode: Single
    ingress:
      external: true
      targetPort: 3000
      transport: http
      allowInsecure: false
    registries:
      - server: "$registry_server"
        username: "$registry_username"
        passwordSecretRef: registry-password
    secrets:
      - name: registry-password
        value: "$registry_password"
      - name: oidc-client-secret
        value: "$oidc_client_secret"
      - name: cookie-secret
        value: "$cookie_secret"
  template:
    scale:
      minReplicas: 1
      maxReplicas: 1
    containers:
      - name: "$APP_NAME"
        image: "$registry_server/$IMAGE_NAME:$IMAGE_TAG"
        resources:
          cpu: $CPU
          memory: $MEMORY
        env:
          - name: NODE_ENV
            value: production
          - name: UI_HOST
            value: 0.0.0.0
          - name: PORT
            value: "3000"
          - name: AZURE_TENANT_ID
            value: "$TENANT_ID"
          - name: AZURE_SUBSCRIPTION_IDS
            value: "$SUBSCRIPTION_ID"
          - name: AZURE_SYNC_CONCURRENCY
            value: "$AZURE_SYNC_CONCURRENCY"
          - name: AZURE_CERT_GUI_DB_PATH
            value: "$AZURE_CERT_GUI_DB_PATH"
          - name: AZURE_CERT_GUI_SQLITE_JOURNAL_MODE
            value: "$AZURE_CERT_GUI_SQLITE_JOURNAL_MODE"
          - name: AZURE_CERT_GUI_AZ_LOGIN_ON_STARTUP
            value: "true"
          - name: AZURE_CERT_GUI__AUTH__MODE
            value: oidc
          - name: AZURE_CERT_GUI__AUTH__ALLOWLOCALINPRODUCTION
            value: "false"
          - name: AZURE_CERT_GUI__AUTH__COOKIESECRET
            secretRef: cookie-secret
          - name: AZURE_CERT_GUI__AUTH__OIDC__AUTHORITY
            value: "https://login.microsoftonline.com/$TENANT_ID/v2.0"
          - name: AZURE_CERT_GUI__AUTH__OIDC__CLIENTID
            value: "$oidc_app_id"
          - name: AZURE_CERT_GUI__AUTH__OIDC__CLIENTSECRET
            secretRef: oidc-client-secret
          - name: AZURE_CERT_GUI__AUTH__OIDC__PUBLICORIGIN
            value: ""
          - name: AZURE_CERT_GUI__AUTH__OIDC__VIEWERGROUPS__0
            value: "$viewer_group_id"
          - name: AZURE_CERT_GUI__AUTH__OIDC__OPERATORGROUPS__0
            value: "$operator_group_id"
          - name: AZURE_CERT_GUI__AUTH__OIDC__ADMINGROUPS__0
            value: "$admin_group_id"
          - name: AZURE_CERT_GUI__ROTATION__LIVEENABLED
            value: "$AZURE_CERT_GUI__ROTATION__LIVEENABLED"
EOF

echo "Creating or updating Container App..."
if run_az containerapp show --resource-group "$RESOURCE_GROUP" --name "$APP_NAME" -o none >/dev/null 2>&1; then
  run_az containerapp update --resource-group "$RESOURCE_GROUP" --name "$APP_NAME" --yaml .runtime/containerapp.yaml -o none
else
  run_az containerapp create --resource-group "$RESOURCE_GROUP" --name "$APP_NAME" --yaml .runtime/containerapp.yaml -o none
fi

fqdn="$(run_az containerapp show --resource-group "$RESOURCE_GROUP" --name "$APP_NAME" --query properties.configuration.ingress.fqdn -o tsv)"
public_origin="https://$fqdn"
redirect_uri="$public_origin/api/auth/callback"
json_patch "https://graph.microsoft.com/v1.0/applications/$oidc_object_id" "{\"groupMembershipClaims\":\"SecurityGroup\",\"web\":{\"redirectUris\":[\"http://localhost:3000/api/auth/callback\",\"$redirect_uri\"],\"implicitGrantSettings\":{\"enableAccessTokenIssuance\":false,\"enableIdTokenIssuance\":false}}}"

run_az containerapp secret set \
  --resource-group "$RESOURCE_GROUP" \
  --name "$APP_NAME" \
  --secrets "oidc-client-secret=$oidc_client_secret" "cookie-secret=$cookie_secret" \
  -o none
run_az containerapp update \
  --resource-group "$RESOURCE_GROUP" \
  --name "$APP_NAME" \
  --set-env-vars "AZURE_CERT_GUI__AUTH__OIDC__PUBLICORIGIN=$public_origin" \
  -o none

principal_id="$(run_az containerapp show --resource-group "$RESOURCE_GROUP" --name "$APP_NAME" --query identity.principalId -o tsv)"
echo "Assigning Azure and Microsoft Graph permissions to managed identity..."
for role in Reader "Key Vault Reader" "Key Vault Secrets User" "Key Vault Certificate User" "Key Vault Crypto User"; do
  run_az role assignment create \
    --assignee-object-id "$principal_id" \
    --assignee-principal-type ServicePrincipal \
    --role "$role" \
    --scope "/subscriptions/$SUBSCRIPTION_ID" \
    -o none >/dev/null 2>&1 || true
done
assign_keyvault_access_policies "$principal_id"
assign_graph_app_roles "$principal_id"
deactivate_zero_traffic_revisions

echo
echo "Azure Cert GUI is deployed."
echo "URL:              $public_origin"
echo "Resource group:   $RESOURCE_GROUP"
echo "Container app:    $APP_NAME"
echo "Container image:  $registry_server/$IMAGE_NAME:$IMAGE_TAG"
echo "OIDC client ID:   $oidc_app_id"
echo "Viewer group:     $viewer_group_id"
echo "Operator group:   $operator_group_id"
echo "Admin group:      $admin_group_id"
echo "Managed identity: $principal_id"
echo
echo "SQLite path:      $AZURE_CERT_GUI_DB_PATH"
echo "Note: The default Container Apps setup uses ephemeral SQLite storage."
echo "      Do not use Azure Files for the live SQLite database; file locking failed in testing."

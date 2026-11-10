import { Type } from "typebox";
import type { Static } from "typebox";

import { managementRequest } from "./management.ts";
import type { ManagementRequestOptions } from "./management.ts";

const SignalsSchema = Type.Record(
  Type.String(),
  Type.Union([Type.String(), Type.Number()])
);

export type Signals = Static<typeof SignalsSchema>;

const NullableString = Type.Optional(Type.Union([Type.String(), Type.Null()]));

/** One upstream account file on the CLIProxyAPI server. */
const CredentialSchema = Type.Object({
  auth_index: Type.String(),
  disabled: Type.Optional(Type.Boolean()),
  email: NullableString,
  label: NullableString,
  name: Type.String(),
  next_retry_after: Type.Optional(Type.String()),
  provider: Type.String(),
  quota: Type.Optional(
    Type.Object({
      observed_at: Type.Optional(Type.String()),
      signals: Type.Optional(SignalsSchema),
    })
  ),
  quota_plugin_id: Type.Optional(Type.String()),
  unavailable: Type.Optional(Type.Boolean()),
});

export type Credential = Static<typeof CredentialSchema>;

const CredentialsSchema = Type.Object({
  files: Type.Array(CredentialSchema),
});

const CredentialModelsSchema = Type.Object({
  models: Type.Array(Type.Object({ id: Type.String() })),
});

export const listCredentials = async (
  options: ManagementRequestOptions
): Promise<Credential[]> => {
  const { files } = await managementRequest(
    options,
    "/credentials",
    CredentialsSchema
  );

  return files;
};

export const activeCredentials = async (
  options: ManagementRequestOptions
): Promise<Credential[]> => {
  const credentials = await listCredentials(options);

  return credentials.filter((credential) => !credential.disabled);
};

export const servedModels = async (
  options: ManagementRequestOptions,
  credential: Credential
): Promise<string[]> => {
  const { models } = await managementRequest(
    options,
    `/credentials/models?name=${encodeURIComponent(credential.name)}`,
    CredentialModelsSchema
  );

  return models.map((model) => model.id);
};

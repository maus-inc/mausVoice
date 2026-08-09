import { FiremixPath } from "@firemix/core";
import {
  Contact,
  DatabaseGlobalDictionary,
  DatabaseMember,
  DatabaseTenant,
  DatabaseTenantInvitation,
  DatabaseTenantMembership,
  DatabaseUser,
  FlaggedAudio,
  Nullable,
  TermDoc,
  ToneDoc,
  Transcription,
} from "@maus-inc/types";
import { listify } from "@maus-inc/utilities";

export const members = (
  memberId?: Nullable<string>,
): FiremixPath<DatabaseMember> => {
  return ["members", ...listify(memberId)];
};

export const users = (userId?: Nullable<string>): FiremixPath<DatabaseUser> => {
  return ["users", ...listify(userId)];
};

export const contacts = (
  contactId?: Nullable<string>,
): FiremixPath<Contact> => {
  return ["contacts", ...listify(contactId)];
};

export const transcriptions = (
  transcriptionId?: Nullable<string>,
): FiremixPath<Transcription> => {
  return ["transcriptions", ...listify(transcriptionId)];
};

export const termDocs = (userId: Nullable<string>): FiremixPath<TermDoc> => {
  return ["termDocs", ...listify(userId)];
};

export const toneDocs = (userId: Nullable<string>): FiremixPath<ToneDoc> => {
  return ["toneDocs", ...listify(userId)];
};

export const flaggedAudio = (
  flaggedAudioId?: Nullable<string>,
): FiremixPath<FlaggedAudio> => {
  return ["flaggedAudio", ...listify(flaggedAudioId)];
};

export const tenants = (
  tenantId?: Nullable<string>,
): FiremixPath<DatabaseTenant> => {
  return ["tenants", ...listify(tenantId)];
};

export const tenantMemberships = (
  membershipId?: Nullable<string>,
): FiremixPath<DatabaseTenantMembership> => {
  return ["tenant_memberships", ...listify(membershipId)];
};

export const tenantInvitations = (
  invitationId?: Nullable<string>,
): FiremixPath<DatabaseTenantInvitation> => {
  return ["tenant_invitations", ...listify(invitationId)];
};

export const globalDictionaries = (
  tenantId?: Nullable<string>,
): FiremixPath<DatabaseGlobalDictionary> => {
  return ["globalDictionaries", ...listify(tenantId)];
};


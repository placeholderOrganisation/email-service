import type { ProjectDoc } from "../models/Project.js";

/** Builds the RFC 5322 From header from a project's stored sender. */
export function formatFrom(project: ProjectDoc): string {
  // fromAddress is optional on the model now (review-only projects have no
  // sender), but any project that reaches the email send path always has one.
  const fromAddress = project.fromAddress ?? "";
  return project.fromName ? `${project.fromName} <${fromAddress}>` : fromAddress;
}

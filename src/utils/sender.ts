import type { ProjectDoc } from "../models/Project.js";

/** Builds the RFC 5322 From header from a project's stored sender. */
export function formatFrom(project: ProjectDoc): string {
  return project.fromName ? `${project.fromName} <${project.fromAddress}>` : project.fromAddress;
}

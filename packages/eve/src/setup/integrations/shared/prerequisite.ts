/** A read-only setup refusal whose prerequisite must be satisfied by a separate command. */
export class SetupPrerequisiteRequired extends Error {
  readonly code: string;
  readonly command: string;

  constructor(input: { code: string; message: string; command: string }) {
    super(input.message);
    this.name = "SetupPrerequisiteRequired";
    this.code = input.code;
    this.command = input.command;
  }
}

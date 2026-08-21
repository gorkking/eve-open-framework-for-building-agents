import { describe, expect, it } from "vitest";
import { createHomeStructuredData } from "./home-structured-data";

describe("homepage structured data", () => {
  it("identifies the site, distributable framework, and source without invented company details", () => {
    const data = createHomeStructuredData();
    const types = data["@graph"].map((entry) => entry["@type"]);
    const software = data["@graph"].find((entry) => entry["@type"] === "SoftwareApplication");

    expect(types).toEqual(["WebSite", "SoftwareApplication", "SoftwareSourceCode"]);
    expect(software).toMatchObject({
      name: "eve",
      applicationCategory: "DeveloperApplication",
      isAccessibleForFree: true,
      license: "https://www.apache.org/licenses/LICENSE-2.0.html",
      url: "https://eve.dev",
    });
    expect(JSON.stringify(data)).not.toContain("Organization");
  });
});

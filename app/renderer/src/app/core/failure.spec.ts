import { TestBed } from "@angular/core/testing";
import { TranslocoService } from "@jsverse/transloco";
import { beforeEach, describe, expect, it } from "vitest";
import { provideI18n } from "./i18n";
import { tell } from "./failure";

describe("telling a failure", () => {
  let transloco: TranslocoService;

  beforeEach(async () => {
    TestBed.configureTestingModule({ providers: [provideI18n("it")] });
    transloco = TestBed.inject(TranslocoService);
    await transloco.load("it").toPromise();
    transloco.setActiveLang("it");
  });

  it("prefers the sentence written for the code", () => {
    const told = tell(transloco, { code: "PROVIDER_OUT_OF_CREDIT", fault: "exhausted" });
    expect(told.body).toBe("Il credito del provider è esaurito.");
    expect(told.hint).toContain("Ricarica");
    expect(told.code).toBe("PROVIDER_OUT_OF_CREDIT");
  });

  /**
   * The floor the fault exists for. A code nobody catalogued used to print
   * itself, bare, in the middle of an Italian sentence; now the class still
   * has something true to say and the identifier goes in the small print.
   */
  it("falls back to the fault when the code is not catalogued", () => {
    const told = tell(transloco, { code: "PROVIDER_INVENTED_TOMORROW", fault: "transient" });
    expect(told.body).toBe("Il provider non ha risposto.");
    expect(told.hint).toContain("riprendi");
    expect(told.code).toBe("PROVIDER_INVENTED_TOMORROW");
  });

  it("says something even for a shape it does not recognise", () => {
    const told = tell(transloco, { unexpected: true });
    expect(told.body).toBeTruthy();
    expect(told.body).not.toContain("faults.");
  });

  it("never returns a bare catalogue key", () => {
    for (const failure of [{ code: "X", fault: "defect" }, null, undefined, "a string"]) {
      const told = tell(transloco, failure);
      expect(told.body.startsWith("codes.")).toBe(false);
      expect(told.body.startsWith("faults.")).toBe(false);
    }
  });
});

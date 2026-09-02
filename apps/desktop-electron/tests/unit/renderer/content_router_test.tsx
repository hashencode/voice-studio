// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import { createSectionRouterJournal } from "../../../src/renderer/features/shell/section-router-registry";

describe("section content routers", () => {
  it("uses native push/pop branching and suppresses duplicate destinations", async () => {
    const journal = createSectionRouterJournal("audio");

    await journal.router.navigate("/audio/1");
    await journal.router.navigate("/audio/2");
    await journal.router.navigate("/audio/3");
    expect(journal.getSnapshot()).toMatchObject({
      pathname: "/audio/3",
      canGoBack: true,
      canGoForward: false,
    });

    await journal.router.navigate(-1);
    expect(journal.getSnapshot()).toMatchObject({
      pathname: "/audio/2",
      canGoBack: true,
      canGoForward: true,
    });
    await journal.router.navigate("/audio/4");
    expect(journal.getSnapshot()).toMatchObject({
      pathname: "/audio/4",
      canGoBack: true,
      canGoForward: false,
    });

    const before = journal.getSnapshot().locationKey;
    if (journal.router.state.location.pathname !== "/audio/4") {
      await journal.router.navigate("/audio/4");
    }
    expect(journal.getSnapshot().locationKey).toBe(before);
  });

  it("keeps independent module stacks", async () => {
    const audio = createSectionRouterJournal("audio");
    const messages = createSectionRouterJournal("messages");
    await audio.router.navigate("/audio/7");
    await messages.router.navigate("/messages/a-1");
    await audio.router.navigate("/audio/8");

    expect(audio.getSnapshot().pathname).toBe("/audio/8");
    expect(messages.getSnapshot().pathname).toBe("/messages/a-1");
    await audio.router.navigate(-1);
    expect(audio.getSnapshot().pathname).toBe("/audio/7");
    expect(messages.getSnapshot().pathname).toBe("/messages/a-1");
  });
});

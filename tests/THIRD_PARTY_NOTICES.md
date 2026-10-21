# Browser fixture notices

## DeepSeek Harness CSS excerpts

The CSS files in `fixtures/` contain test-only excerpts adapted from
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) at commit
`687f282e8625c6b8d11ff58211a90524be2e4317`, sampled on 2026-10-21.
The local upstream checkout's HEAD and its recorded source lock were both
verified to match that commit. No network fetch was used to create the snapshots.

Copyright (c) 2026 DeepSeek. **License: MIT**, as stated in the upstream root
LICENSE at this commit. The complete original notice and permission text is
preserved in [fixtures/LICENSE.deepseek-harness](fixtures/LICENSE.deepseek-harness).
These CSS excerpts are not Apache-2.0 licensed.

| Fixture | Pinned upstream sources | Adaptation |
| --- | --- | --- |
| `host-theme.css` | [design-platform.css](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/client/ui-theme/src/styles/design-platform.css) | Retains only the light/dark theme properties used by the fixture or client, their transitive color references, and body background. |
| `host-footer.css` | [MessageIconActions.module.css](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/client/ui-chat/src/client/chat/MessageIconActions.module.css), [TurnUsagePanel.module.css](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/client/ui-chat/src/client/chat/TurnUsagePanel.module.css) | Retains the assistant footer geometry and usage control styles; omits unused user-clock and reveal behavior. |
| `host-composer.css` | [InputBar.module.css](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/client/ui-conversation/src/client/skeleton/InputBar.module.css), [ConversationRoot.module.css](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/client/ui-conversation/src/client/skeleton/ConversationRoot.module.css) | Retains the root, card, statistics dock, main width variables and embedded width variables. Class selectors are renamed to `fixture-*`. |
| `host-settings.css` | [SettingsRoot.module.css](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/client/ui-settings-general/src/client/SettingsRoot.module.css) | Retains the panel, navigation and content-column styles. Class selectors are renamed to `fixture-settings-*`; launcher styles are omitted. |

Comments and unused declarations/selectors were removed for a small snapshot.
The fixture is a bounded host-layout regression model, not a copy of the whole
DSH application. Updating its upstream version requires reviewing these sources
and notices together.

## Development dependencies

The browser test resolves the package's locked development dependencies. They
are not copied into `fixtures/`:

| Package | Tested version | Upstream license |
| --- | --- | --- |
| `playwright` | `1.62.1` | Apache-2.0; see the dependency's `LICENSE`. |
| `react` | `18.3.1` | MIT; see the dependency's `LICENSE`. |
| `react-dom` | `18.3.1` | MIT; see the dependency's `LICENSE`. |

## Synthetic data and screenshots

All browser API responses are fixed mock data served by the test's temporary
localhost server. The fixture does not read local session records, credentials,
provider endpoints, or live profiles. Session titles and tool names are synthetic
demonstration labels. Generated screenshots show this fixture, not a user's DSH
session.

`DSH_CACHE_HELPER_TEST_ARTIFACT` optionally points to an unpacked package root;
the same test then loads its `lib/client.js`. React, Playwright and CSS fixtures
continue to resolve from this test checkout, without requiring development files
inside the packed artifact.

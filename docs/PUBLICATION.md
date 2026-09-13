# Source-repository publication boundaries

These rules apply to the ClawCode product source repository. An operator's agent workspace has separate ownership and privacy requirements.

Publish source code, synthetic tests, empty configuration examples, reusable templates, installation and usage guides, technical designs, and concise release/verification summaries. The root identity and user files distributed with the plugin are templates; never replace them with an operator's populated files in the product repository.

Keep personal-agent investigations, conversations, memory exports, credentials, real contact/session identifiers, private workspace files, raw incident logs and screenshots/audio from actual use outside the product repository. Translating, renaming or moving such material into a history folder does not make it appropriate for publication. Retain only the technical conclusion needed to understand a product change, without the private incident narrative.

Review tracked files, the staged diff and links before committing. Pull-request descriptions, comments, GitHub Releases, source archives and old commits are also publication surfaces. Do not add commit-pinned links to private notes or raw evidence. Keep the scope and limits of technical verification accurate after redaction.

Removing a file or personal detail from the current branch does not erase earlier Git history or external copies. A full history cleanup or visibility change requires its own reviewed plan and authorization; a clean source tree alone is not proof that all historical material is suitable for public access.

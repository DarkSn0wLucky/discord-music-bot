# Codex Notes

- Long tasks should be split into small independent subtasks; use parallel subagents for independent long-running investigation or implementation work when it materially helps.
- Ask for permission before sensitive, risky, or broad changes unless the user has already explicitly authorized that exact class of action.
- The user permits handling and transferring sensitive bot-maintenance data, such as cookies, SSH keys, and service credentials, when needed for the requested work. Prefer direct local/server file transfer and avoid printing secret values in chat, command output, commits, or logs unless the user explicitly asks for the value itself.
- The bot has a Gemini API integration. Do not use Gemini as an external coding helper or subagent. It may be used only as an implemented bot feature when Gemini directly solves a bot/user workflow.

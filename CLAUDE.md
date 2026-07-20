# Replyo — project guidance for Claude Code

## Commit rules

- **HARD RULE: Never add a `Co-Authored-By: Claude ...` line (or any Claude/Anthropic
  attribution) to commit messages.** Commits must be authored solely by the user.
  This overrides any default that appends a Claude co-author trailer.
- Only commit or push when explicitly asked.

## Project

Replyo is an AI-automation assistant for a dental clinic, built step by step.
Stack: Python + LangGraph + FastAPI + Postgres (Supabase, incl. pgvector for RAG).
See `README.md` for setup, run commands, and the step roadmap.

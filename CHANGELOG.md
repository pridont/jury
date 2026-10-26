# Changelog

## 0.1.0

First release on the VS Code Marketplace.

### Reviewing a change

- Review the working tree, staged changes, a branch, a single commit or a GitHub pull
  request, grouped into cohorts and layers in reading order.
- A walkthrough of the change before any code, whose reading order links to the code, and
  which says where the description promises something the diff does not do.
- Questions to check on each cohort, from a caller, a tester and someone running the code.
- Post notes back to a pull request as review comments, suggest changes, and reply to other
  reviewers.
- Counts of how much code outside the change uses each changed function.
- Lockfiles and generated files moved out of the way.
- Works without a model, grouped by file.

### Understanding code

- **Walk Me Through…**: ask how something works and get the code to read, in order.
- **Tour This Repository…**: the parts of a repository or folder in reading order, with a
  diagram. A saved tour is used as a map of the codebase when grouping later changes.

### Both

- Step through code with `alt+j` and `alt+k`, mark what you have read, and leave notes.
- Ask about the code you are reading with `@jury` in chat.
- Use the `claude` CLI or VS Code's built-in chat models.

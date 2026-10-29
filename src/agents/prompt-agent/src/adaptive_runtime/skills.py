"""Native, on-demand skills from the immutable deployment snapshot."""

import json

from agent_framework import InlineSkill, InMemorySkillsSource, SkillFrontmatter, SkillsProvider


def build_skills_provider(raw: str) -> SkillsProvider | None:
    files = json.loads(raw)
    if not isinstance(files, list) or len(files) > 8:
        raise ValueError("AGENT_SKILLS must be a list of at most eight captured skill files")
    skills: list[InlineSkill] = []
    names: set[str] = set()
    total = 0
    for file in files:
        if (
            not isinstance(file, dict)
            or set(file) != {"path", "content", "name", "description"}
            or not all(isinstance(value, str) for value in file.values())
        ):
            raise ValueError("AGENT_SKILLS must contain complete captured skill files")
        metadata = SkillFrontmatter(name=file["name"], description=file["description"])
        content = file["content"]
        size = len(content.encode("utf-8"))
        total += size
        if (
            file["path"] != f"{metadata.name}/SKILL.md"
            or metadata.name in names
            or not content.strip()
            or size > 8192
            or total > 32768
        ):
            raise ValueError("Invalid, duplicate or oversized captured skill")
        names.add(metadata.name)
        skills.append(InlineSkill(frontmatter=metadata, instructions=content))
    return (
        SkillsProvider(
            InMemorySkillsSource(skills),
            disable_load_skill_approval=True,
        )
        if skills
        else None
    )

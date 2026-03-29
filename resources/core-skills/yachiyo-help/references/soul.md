# Soul Traits — CLI Reference

The SOUL document (`~/.yachiyo/SOUL.md`) defines the assistant's personality and behavioral tendencies. The `traits` section holds a list of evolving observations that build up over time.

## Commands

### List traits

```
yachiyo soul traits list
```

Print all current soul traits as JSON (index + text pairs).

### Add a trait

```
yachiyo soul traits add "<trait text>"
```

Append a new trait. The text is stored under today's date heading inside SOUL.md.

### Remove a trait

```
yachiyo soul traits remove <index-or-text>
```

Remove a trait by its numeric index (from `list`) or by matching text substring.

<script>
  import { parseMc } from '../lib/format.js';
  let { name = '' } = $props();
  const segs = $derived(parseMc(name));
</script>

<span class="mc">{#each segs as s}<span
      style:color={s.color || undefined}
      style:font-weight={s.bold ? '600' : undefined}
      style:font-style={s.italic ? 'italic' : undefined}
      style:text-decoration={[s.underline ? 'underline' : '', s.strike ? 'line-through' : ''].join(' ').trim() || undefined}
    >{s.text}</span>{/each}</span>

<style>
  .mc { word-break: break-word; }
</style>

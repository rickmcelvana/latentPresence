# Wheel of the Year

A content-only latentPresence plugin for Yule, Imbolc, Ostara, Beltane, Litha,
Lughnasadh / Lammas, Mabon and Samhain. Each holiday includes its names, dates for
both hemispheres, festival type, a detailed theme, modern observances and source links.

## Install

In latentPresence, open **Settings → Plugins → Install from a folder…**, choose this
folder, complete installation and enable the plugin for a character.

Try:

- "What holiday is coming up?"
- "What Wheel of the Year holiday passed most recently?"
- "I'm in Australia. What seasonal holiday comes next?"
- "Tell me about Mabon and how people observe it today."
- "What is Lammas?"

## How it works

The plugin id is `wheel-of-the-year` (the manifest format does not allow underscores
in ids). The workspace folder can remain `wheel_of_the_year`.

- `wheel-of-the-year__get_calendar` looks up a compact calendar for `north` (default)
  or `south`. The character compares it with the app's local date in its RIGHT NOW
  prompt, or with a reference date provided by the user.
- `wheel-of-the-year__get_holiday` looks up the detailed record by canonical id.
  Alternate names such as Lammas are mapped to that id by the character's instructions.

Only the documented `lookup` step is used. There is no executable plugin code, MCP
server, remote asset or network request. Source URLs in the data are references for
readers; the plugin does not fetch them.

The date comparison is performed by the character, not by an executable calendar
engine. Fixed-date windows cover common eve/day and alternate-date practices. Solar
windows are deliberately approximate: an exact equinox or solstice date, instant or
countdown needs year-specific astronomy data and a timezone. Near those windows, the
character is instructed to say the festival falls around now rather than guess whether
the exact instant has passed.

Northern dates are the fallback when location and practice are unknown, and the
character should state that assumption. The southern calendar follows seasonal shifts;
the user's own tradition takes precedence. The descriptions are examples of modern
practice, not a claim that every Pagan community uses one calendar or set of customs.

## Data

`data/calendars.json` contains two rows with ordered holiday windows.
`data/holidays.json` contains eight full holiday records. When editing dates, keep
the calendar's `dates` equal to the corresponding holiday's `dates_north` or
`dates_south`; keep ids and `date_basis` consistent across both files.

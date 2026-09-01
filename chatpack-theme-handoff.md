# Chatpack theme — handoff (deliverable 4.1)

Derived from the brand palette already defined in the Chatpack Webflow site.
All contrast ratios below are WCAG 2.1, computed, not estimated.

## Light

background                  #f6f6f1
foreground                  #353849
card                        #ffffff
card-foreground             #353849
popover                     #ffffff
popover-foreground          #353849
primary                     #103225
primary-foreground          #f6f6f1
secondary                   #e4eac8
secondary-foreground        #103225
muted                       #e8e5e3
muted-foreground            #5a5f6b
accent                      #d2f338
accent-foreground           #103225
destructive                 #9e2f22
border                      #e8e5e3
input                       #8d877f
ring                        #103225
sidebar                     #f0efe9
sidebar-foreground          #353849
sidebar-primary             #103225
sidebar-primary-foreground  #f6f6f1
sidebar-accent              #e4eac8
sidebar-accent-foreground   #103225
sidebar-border              #e8e5e3
sidebar-ring                #103225

## Dark

background                  #031919
foreground                  #f6f6f1
card                        #0b2219
card-foreground             #f6f6f1
popover                     #0b2219
popover-foreground          #f6f6f1
primary                     #d2f338
primary-foreground          #031919
secondary                   #103225
secondary-foreground        #f6f6f1
muted                       #103225
muted-foreground            #9aa89f
accent                      #103225
accent-foreground           #d2f338
destructive                 #f2796b
border                      #1c3a2e
input                       #3f7a61
ring                        #d2f338
sidebar                     #0b2219
sidebar-foreground          #f6f6f1
sidebar-primary             #d2f338
sidebar-primary-foreground  #031919
sidebar-accent              #103225
sidebar-accent-foreground   #f6f6f1
sidebar-border              #1c3a2e
sidebar-ring                #d2f338

## Radius

--radius: 0.75rem

Was 0.625rem. 0.75rem matches the marketing site's floating surfaces
(.chatnav_dropdown-card = 12px, .prompt_modal-panel = 0.75rem).

## The two hardcoded colours

online dot        #d2f338   (replaces emerald-500)
mention ring      #e7b01a   (replaces amber-400)

Lime is already the site's status-dot colour (.demo_label-dot).
Gold is the site's existing secondary accent.

## Verified contrast

Light
  foreground / background             10.68:1  AAA
  primary-foreground / primary        12.87:1  AAA
  secondary-foreground / secondary    11.23:1  AAA
  muted-foreground / muted             5.10:1  AA
  accent-foreground / accent          11.04:1  AAA
  sidebar-fg / sidebar                10.05:1  AAA
  input / background                   3.28:1  pass (non-text 3:1)
  destructive: white on it 7.28:1, it on background 6.72:1

Dark
  foreground / background             16.74:1  AAA
  primary-foreground / primary        14.36:1  AAA
  secondary-foreground / secondary    12.87:1  AAA
  muted-foreground / muted             5.63:1  AA
  accent-foreground / accent          11.04:1  AAA
  sidebar-fg / sidebar                15.41:1  AAA
  input / background                   3.60:1  pass (non-text 3:1)
  destructive on background            6.67:1

## Notes for engineering

1. Primary flips between modes. Light: deep green primary, lime accent.
   Dark: lime primary, green-deep as surface. This is deliberate — lime is
   unusable as a button on off-white, deep green is invisible on green-black.

2. `border` is intentionally soft (1.16:1 light, 1.46:1 dark). It is decorative
   separation, not a control boundary. `input` is a separate, darker value
   because it IS a control boundary and needs 3:1.

3. Lime does triple duty in dark mode: primary, ring, and the online dot.
   If own-message bubbles map to `primary`, a dark thread becomes a column of
   bright lime. Watch for this — if it reads badly, own bubbles need a muted
   lime rather than the token.

4. `destructive` is the one value with no source in the brand palette. The
   site's existing red pair (#f8e4e4 / #3b0b0b) is a badge combination, not a
   button colour. Both values above are new and are open to a different call.

## Also found, not part of this deliverable

Typography in use on the marketing site:
  Uncut Sans  — display / headings
  Inter       — UI text
  Geist Mono  — uppercase labels, metadata

The Webflow site's own semantic theme layer is still wired to leftover template
blue (Brand/blue #2d62ff), which no style actually uses, and its Dark Mode has
values identical to Base — dark mode is not really built there. Separate
cleanup, but worth knowing.

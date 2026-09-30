# What it looks like

Every page of the dashboard, as it renders.

The work in these pictures is invented. The layout, the wording and the
numbers are the dashboard's own, computed from a collection with the shape
of a real one — a year of postings, spread over the lists at the rate
somebody really posts to them — but every subject, person, address, message
id and commit hash in it was made up. Nobody's record is on show here.

<div align="center">

<picture>
  <source media="(prefers-color-scheme: light)" srcset="images/shot-light.png">
  <source media="(prefers-color-scheme: dark)"  srcset="images/shot-dashboard.png">
  <img src="images/shot-dashboard.png" alt="The overview page" width="900">
</picture>

<sub>The overview: the road to mainline, and every patch in exactly one bucket
underneath it.</sub>

</div>

The road counts each patch once, at the version that speaks for it, so the
357 at the left of it is the number of patches written rather than the number
of times something was posted. Each stage says how many got at least that
far, how many are sitting there now, and how many reached it and then
stopped; the dustbin opens that last group.

<details>
<summary><b>&#127988; Your turn</b> &#8212; the threads waiting on a reply, and the series to respin</summary>
<br>
<img src="images/shot-your-turn.png" alt="The your turn page" width="100%">
</details>

<details>
<summary><b>&#128203; Patches</b> &#8212; every patch you ever posted, and where each one got to</summary>
<br>
<img src="images/shot-patches.png" alt="The patches page" width="100%">
</details>

<details>
<summary><b>&#128269; The same list, narrowed</b> &#8212; every column has a dropdown, and every option says what it would leave</summary>
<br>
<img src="images/shot-filtered.png" alt="The patch list filtered to what was dropped after somebody replied" width="100%">
<br>
<sub>This is where a dustbin on the road lands: the patches that got a reply
and then stopped for good.</sub>
</details>

<details>
<summary><b>&#10003; Outcomes</b> &#8212; the commits that landed, and which trees carry them</summary>
<br>
<img src="images/shot-outcomes.png" alt="The outcomes page" width="100%">
</details>

<details>
<summary><b>&#128465; Dropped</b> &#8212; what stopped, why, and how far it had got first</summary>
<br>
<img src="images/shot-dropped.png" alt="The dropped tab" width="100%">
<br>
<sub>A patch you improved and sent again is not here: the newer version
speaks for it, and the older one is on its record.</sub>
</details>

<details>
<summary><b>&#9993; Discussions</b> &#8212; threads, the people who replied, and the review tags you collected</summary>
<br>
<img src="images/shot-discussions.png" alt="The discussions page" width="100%">
</details>

<details>
<summary><b>&#128200; Insights</b> &#8212; when you post, which subsystems, which trees</summary>
<br>
<img src="images/shot-insights.png" alt="The insights page" width="100%">
</details>

<details>
<summary><b>&#128214; One patch, read in place</b> &#8212; what it needs from you, the versions, and the whole conversation</summary>
<br>
<img src="images/shot-thread.png" alt="A patch opened in the drawer" width="100%">
</details>

<details>
<summary><b>&#128190; One commit, with the change in it</b> &#8212; clicking a commit id reads the patch off git.kernel.org</summary>
<br>
<img src="images/shot-commit.png" alt="A commit opened in the drawer, with its diff" width="100%">
<br>
<sub>The message, the files it touched and the diff itself, without leaving
the page.</sub>
</details>

<details>
<summary><b>&#8981; Discover</b> &#8212; anybody else's patches: sent, accepted, queued, merged</summary>
<br>
<img src="images/shot-discover-empty.png" alt="Discover, before anybody has been looked up" width="100%">
<br>
<img src="images/shot-discover.png" alt="Discover, showing what patchwork has accepted from one address" width="100%">
<br>
<sub>Counted from patchwork and git.kernel.org, which is what everybody can
see. Nothing here comes from anyone's dashboard.</sub>
</details>

<details>
<summary><b>&#9881; Settings</b> &#8212; refresh, the assistant, the sources, and the explanations folded behind an <i>i</i></summary>
<br>
<img src="images/shot-settings.png" alt="The settings page" width="100%">
</details>

<details>
<summary><b>&#128172; Support</b> &#8212; the answers first, then a way to say what is wrong</summary>
<br>
<img src="images/shot-support.png" alt="The support tab, with the feedback box" width="100%">
</details>

<details>
<summary><b>&#128233; Admin</b> &#8212; reports to answer and word to send out, for whoever runs the deployment</summary>
<br>
<img src="images/shot-feedback.png" alt="The owner's admin section" width="100%">
<br>
<sub>A section only the owner has, carrying the number of reports nobody
has read yet. The owner is <code>PATCHVANE_OWNER</code> where that is set
and whoever signed in first where it is not, and the server checks it again
on every request rather than trusting the page.</sub>
</details>

<details>
<summary><b>&#9728; In the light</b> &#8212; the same page in the other theme</summary>
<br>
<img src="images/shot-light.png" alt="The overview page in the light theme" width="100%">
</details>

<details>
<summary><b>&#128274; Signing in</b> &#8212; a username or an address and a password; new accounts prove the address with a code</summary>
<br>
<img src="images/shot-login.png" alt="The sign-in page" width="100%">
</details>

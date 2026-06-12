# Benchmark

Les chiffres sont très bons. Tu bats Express partout (+30 % environ), et sur `json-echo` tu dépasses même Fastify (73k vs 70k). L'écart ne porte que sur les scénarios à dominante *routing* (hello, route-param, chain), où Fastify mène d'~25 %. Laisse-moi regarder ton dispatch pour t'expliquer précisément d'où vient l'écart.Bonne nouvelle d'abord : ton intuition est en partie juste. Là où le travail dominant n'est pas le routing — `json-echo`, où le coût est `JSON.parse`/`stringify` que les deux paient à l'identique (on a désactivé le fast-path de sérialisation de Fastify) — tu passes **devant** Fastify (73k vs 70k). L'écart ne vit que sur le chemin de dispatch. Donc Fastify n'est pas « plus léger » que toi ; il a un chemin par-requête mieux taillé pour V8. J'ai lu ton `router.ts`, voici concrètement d'où vient l'écart.

**1. L'algorithme de routeur : scan regex linéaire vs arbre radix.** Ta boucle `next()` fait `while (idx < routes.length)` et exécute `layer.regex.exec(path)` / `.test(path)` sur chaque layer jusqu'à match (lignes 985, 1469, 1698-1702). C'est O(n) exécutions de regex par requête, et chaque `.exec` avec groupes nommés alloue un objet match + un objet groups. Fastify utilise `find-my-way`, un arbre radix (trie compressé) : O(longueur du path), **zéro regex** pour les routes statiques et paramétrées, zéro allocation de match. Avec peu de routes l'écart reste modéré, mais un parcours de trie est intrinsèquement moins cher qu'un `RegExp.exec`.

**2. Tu fais du travail eager sur *chaque* requête dans `updateHttpObjects`**, même quand le handler n'en a pas besoin :

- `new URL(\`http://${host}${req.url}\`)` (ligne 1144) — le constructeur WHATWG URL est l'un des appels les plus lourds du chemin : parsing/validation complète + allocation d'un objet URL et de son `searchParams`. Fastify fait un simple split sur `?` et ne parse la query que si on y accède.
- Tu construis plusieurs objets et fais **deux passes** sur les paramètres (`searchParams.entries()` puis `Object.entries`) même sans query string.
- Tu alloues **3 closures par requête** — `rReq.json`, `rReq.text`, `rReq.formData` (lignes 1206-1254) plus `resolvedReqOpts` — créées même si le body n'est jamais lu. Plus ~8 helpers `res.*` (send/json/status/redirect/cookie…). Fastify n'attache pas de closures par requête.
- Tu parses les cookies et poses `X-Powered-By` systématiquement.

Chacun est minuscule, mais à 90k req/s ce sont autant d'allocations qui nourrissent le GC.

**3. Hidden classes / mégamorphisme.** Tu greffes dynamiquement une quinzaine de propriétés (`ip`, `path`, `queries`, `params`, `cookies`, `json`, `text`…) sur les objets `IncomingMessage`/`ServerResponse` bruts, dont V8 a déjà figé la forme. Ces ajouts forcent des transitions de hidden-class et un accès propriété plus lent. Fastify crée **ses propres** objets Request/Reply à forme fixe et déclarée par route (factory + prototype), donc V8 les garde monomorphes.

**4. La boucle de dispatch elle-même** alloue des closures par hop (`invoke`, `next`, l'arrow strip-path ligne 1710) et enveloppe chaque appel dans try/catch + `ret instanceof Promise`. Fastify compile la chaîne hooks/handler à l'avance, une fois par route.

En clair : tu ne fais pas « trop », tu paies des coûts peu V8-friendly (dispatch regex, URL parsée eager, closures par requête, augmentation dynamique d'objets) qu'un design trie + objets à forme stable évite.

Si tu veux refermer l'écart, sans ajouter de dépendance, par ordre de rendement/risque :

1. **Tout rendre lazy** — ne crée `json/text/formData`, ne parse cookies et query qu'au premier accès (getters définis une fois sur un prototype). Retire ~4 allocations du chemin chaud. Gros gain, risque faible.
2. **Remplacer `new URL()`** par un split manuel sur le premier `?` ; parser la query seulement si lue. C'est l'appel le plus cher isolé.
3. **Forme de requête stable** — initialiser tous les champs augmentés dans un ordre fixe (idéalement via une classe/prototype) pour garder une seule hidden-class.
4. **Routeur radix** pour le fast-path statique/paramétré, en retombant sur la regex uniquement pour les globs/RegExp/contraintes `:id(\d+)`. C'est le gain structurel majeur — mais le plus de travail et le plus de risque pour ta suite de tests. À garder en phase 2.

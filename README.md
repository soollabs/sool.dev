# sool.dev

This repository holds the Sool Labs website, and the files it serves are in `public/`.

Preview it at http://127.0.0.1:8080 with:

```sh
python3 -m http.server 8080 -d public
```

Run the tests with:

```sh
node --test tools/site.test.cjs
```

GitHub Actions deploys `main` to sool.dev and adds a preview link to each pull request.

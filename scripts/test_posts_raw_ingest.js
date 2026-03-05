// scripts/test_posts_raw_ingest.js
const { upsertPostsRaw } = require("../lib/posts_raw_ingest");

async function main() {
  // Minimal fake post payload for MVP
  const posts = [
    {
      post_url: "https://facebook.com/groups/example/permalink/123",
      group_id: "dorset_test_group_1",
      group_name: "Dorset Test Group",
      group_url: "https://facebook.com/groups/example",
      author_name: "Test User",
      text: "Test lead post",
      raw: { source: "test" },
    },
  ];

  const result = await upsertPostsRaw(posts);
  console.log(result);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

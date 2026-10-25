import unittest
import torch
from train_market import split_matches, counts, features, quantiles, PHASES, LETTERS, BINS, QUANTILES


class TrainingChecks(unittest.TestCase):
    def test_chronological_split_purges_overlapping_matches(self):
        matches = [{"id": str(i), "startedAt": {"__timestamp_micros_since_unix_epoch__": str(i * 100)},
                    "endedAt": {"__timestamp_micros_since_unix_epoch__": str(i * 100 + 150)}}
                   for i in range(20)]
        splits = split_matches(list(reversed(matches)))
        for left, right in [("train", "validation"), ("validation", "test")]:
            self.assertLess(max(int(m["endedAt"]["__timestamp_micros_since_unix_epoch__"]) for m in splits[left]),
                            min(int(m["startedAt"]["__timestamp_micros_since_unix_epoch__"]) for m in splits[right]))
        ids = [m["id"] for games in splits.values() for m in games]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertNotIn("13", ids)
        self.assertNotIn("16", ids)

    def test_contexts_counts_and_exported_quantiles_match_runtime_layout(self):
        x = features()
        self.assertEqual(x.shape, (PHASES * LETTERS, 27))
        self.assertEqual(x[0, 0].item(), 1)
        self.assertEqual(x[-1, 25].item(), 1)
        self.assertEqual(x[0, -1].item(), 0)
        self.assertEqual(x[-1, -1].item(), 1)
        data = counts([(26 * 4 + 2, 17), (26 * 4 + 2, 17), (26 * 4 + 2, 0)])
        self.assertEqual(data[26 * 4 + 2, 17].item(), 2)
        self.assertEqual(data.sum().item(), 3)
        p = torch.zeros(PHASES * LETTERS, BINS)
        p[:, 0] = .25
        p[:, 40] = .75
        table = quantiles(p)
        self.assertEqual(len(table), PHASES)
        self.assertEqual(len(table[0]), LETTERS)
        self.assertEqual(table[4][2], [0] * (QUANTILES // 4) + [40] * (QUANTILES * 3 // 4))

    def test_dataset_uses_archived_labels_and_rejects_missing_quotes(self):
        from train_market import dataset
        h = {"bots": [{"id": str(i), "isSimulated": False} for i in range(4)],
             "participants": [], "matches": [], "auctions": [], "topBids": []}
        for i in range(20):
            h["matches"].append({"id": str(i), "status": {"tag": "Ended"},
                                 "auctionType": {"tag": "Vickrey"}, "startingRackSize": 5,
                                 "startedAt": {"__timestamp_micros_since_unix_epoch__": str(i * 100)},
                                 "endedAt": {"__timestamp_micros_since_unix_epoch__": str(i * 100 + 68)}})
            h["participants"].extend({"matchId": str(i), "botId": str(b)} for b in range(4))
            for j in range(68):
                auction = str(i * 68 + j)
                h["auctions"].append({"matchId": str(i), "auctionId": auction, "letter": "A"})
                h["topBids"].append({"auctionId": auction, "topBid": str(j)})
        splits, rows = dataset(h, 20)
        self.assertEqual(rows["train"][0], (67 * 26, 0))
        self.assertEqual(rows["train"][67], (0, 67))
        self.assertEqual(len(rows["test"]), len(splits["test"]) * 68)
        h["topBids"].pop(0)
        with self.assertRaises(KeyError):
            dataset(h, 20)


if __name__ == "__main__":
    unittest.main()

import unittest
from improve_policy import paired, promote, proposal, DEFAULTS


class ImprovementChecks(unittest.TestCase):
    def replay(self, scores, wins=0):
        return {"historyHash": "frozen", "all": {"win": wins},
                "results": [{"match": str(i), "score": score, "balance": 100 + score - 20,
                             "spent": 20, "usedTiles": 5, "unusedTiles": 1, "acquired": 1,
                             "initialRack": {"A": 5}} for i, score in enumerate(scores)]}

    def test_promotion_rejects_regressions_uncertainty_and_replay_win_loss(self):
        baseline = self.replay([70, 80, 90], .2)
        self.assertTrue(promote(paired(baseline, self.replay([75, 85, 95], .3))))
        self.assertFalse(promote(paired(baseline, self.replay([75, 85, 95], .1))))
        self.assertFalse(promote(paired(baseline, self.replay([60, 80, 90], .2))))
        self.assertFalse(promote(paired(baseline, self.replay([90, 60, 95], .3))))
        self.assertEqual(proposal(DEFAULTS, "market")["parameters"], DEFAULTS)

    def test_pairing_refuses_different_matches_snapshots_and_racks(self):
        a = self.replay([70, 80])
        with self.assertRaises(ValueError):
            paired(a, self.replay([70]))
        b = self.replay([70, 80]); b["historyHash"] = "changed"
        with self.assertRaises(ValueError):
            paired(a, b)
        b = self.replay([70, 80]); b["results"][0]["initialRack"] = {"B": 5}
        with self.assertRaises(ValueError):
            paired(a, b)




class ObservedTileChecks(unittest.TestCase):
    def test_proposal_preserves_opt_in_and_rejects_invalid_flags(self):
        self.assertNotIn("observedTiles", proposal(DEFAULTS, "market", 64))
        self.assertTrue(proposal(DEFAULTS, "market", 64, True)["observedTiles"])
        for invalid in [None, 1, "true"]:
            with self.assertRaises(ValueError):
                proposal(DEFAULTS, "market", 64, invalid)


if __name__ == "__main__":
    unittest.main()

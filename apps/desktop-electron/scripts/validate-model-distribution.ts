import {
  productionModelCatalog,
  validateProductionModelCatalog,
} from "../src/main/resources/production_model_catalog";

validateProductionModelCatalog(productionModelCatalog);

const eligible = productionModelCatalog.filter(
  (entry) => entry.distributionEligible,
);
const productionDownloadsOpen =
  eligible.length === productionModelCatalog.length;

process.stdout.write(
  `${JSON.stringify(
    {
      schemaVersion: 1,
      bundleCount: productionModelCatalog.length,
      eligibleBundleIds: eligible.map((entry) => entry.id),
      productionDownloadsOpen,
    },
    null,
    2,
  )}\n`,
);

if (process.argv.includes("--release") && !productionDownloadsOpen) {
  const blocked = productionModelCatalog
    .filter((entry) => !entry.distributionEligible)
    .map((entry) => entry.id);
  process.stderr.write(
    `model distribution release admission is closed: ${blocked.join(", ")}\n`,
  );
  process.exitCode = 1;
}

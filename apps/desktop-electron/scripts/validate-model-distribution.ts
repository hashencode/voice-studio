import {
  productionModelCatalog,
  validateProductionModelCatalog,
} from "../src/main/resources/production_model_catalog";

validateProductionModelCatalog(productionModelCatalog);

const eligible = productionModelCatalog.filter(
  (entry) => entry.distributionEligible,
);

process.stdout.write(
  `${JSON.stringify(
    {
      schemaVersion: 1,
      bundleCount: productionModelCatalog.length,
      eligibleBundleIds: eligible.map((entry) => entry.id),
      productionDownloadsOpen:
        eligible.length === productionModelCatalog.length,
    },
    null,
    2,
  )}\n`,
);

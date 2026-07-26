import 'package:flutter/material.dart';
import 'package:media_kit/media_kit.dart';

import 'app/desktop_app.dart';
import 'app/desktop_bootstrap.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  MediaKit.ensureInitialized();
  final homeController = await DesktopBootstrap.createHomeController();
  runApp(Voice2TextDesktopApp(homeModel: homeController));
}

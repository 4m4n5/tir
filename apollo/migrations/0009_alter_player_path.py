# Generated by Django 3.2.4 on 2021-06-20 21:26

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('apollo', '0008_targetword_path'),
    ]

    operations = [
        migrations.AlterField(
            model_name='player',
            name='path',
            field=models.CharField(default='"{\'word_list\': [\'word1\']}"', max_length=1000),
        ),
    ]